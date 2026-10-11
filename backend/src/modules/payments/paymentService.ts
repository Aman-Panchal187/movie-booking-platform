import { createHash, randomBytes } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, selectOne, selectRows, sequelize } from '../../shared/database/sequelize';
import { CacheService } from '../../shared/cache/cacheService';
import { AppError, forbidden, notFound } from '../../shared/errors/errors';
import { AuthUser } from '../../shared/middleware/auth';
import { bookingsConfirmed, paymentReplays, paymentsTotal } from '../../shared/observability/metrics';
import { withSpan } from '../../shared/observability/spans';

/*
 * MOCK payments only. The simulation is deterministic and synchronous: a card number ending in
 * 0002 is declined, everything else succeeds. Because it settles inside one database transaction,
 * the PAYMENT_PROCESSING booking status and payment_processing_expires_at column are reserved for a
 * real asynchronous gateway (see README "Real payments").
 *
 * Idempotency: payments(user_id, idempotency_key) is UNIQUE. INSERT ... ON CONFLICT DO NOTHING blocks
 * until a concurrent transaction using the same key finishes, so duplicates see the persisted result.
 */

export interface PaymentRequest {
  bookingId: string;
  amountMinor: number;
  cardNumber: string;
  cardHolder: string;
}

export interface PaymentResult {
  httpStatus: number;
  body: Record<string, unknown>;
  replayed: boolean;
}

interface PaymentRow {
  id: string;
  requestHash: string;
  responseStatus: number | null;
  responsePayload: Record<string, unknown> | null;
}

interface BookingLock {
  id: string;
  userId: string;
  status: string;
  total: number;
  currency: string;
  holdValid: boolean;
}

const DECLINE_SUFFIX = '0002';

/** Fingerprint of the logically meaningful payload (never includes the full card number). */
export function requestFingerprint(req: PaymentRequest): string {
  const normalized = JSON.stringify({
    bookingId: req.bookingId,
    amountMinor: req.amountMinor,
    cardLast4: req.cardNumber.slice(-4),
    cardHolder: req.cardHolder.trim().toLowerCase(),
  });
  return createHash('sha256').update(normalized).digest('hex');
}

const transactionReference = () => `MOCKTXN-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
const ticketNumber = () => `TKT-${randomBytes(6).toString('hex').toUpperCase()}`;

export class PaymentService {
  constructor(private readonly cache: CacheService) {}

  async pay(user: AuthUser, idempotencyKey: string, req: PaymentRequest): Promise<PaymentResult> {
    return withSpan('payment.mock', { 'booking.id': req.bookingId }, async () => {
      // Cheap, lock-free ownership check so strangers never touch another user's booking state.
      const owner = await selectOne<{ userId: string }>('SELECT user_id AS "userId" FROM bookings WHERE id = $1', [
        req.bookingId,
      ]);
      if (!owner) throw notFound('Booking');
      if (owner.userId !== user.id) throw forbidden('This booking belongs to another user');

      const hash = requestFingerprint(req);
      const result = await sequelize.transaction((transaction) =>
        this.payInTransaction(user, idempotencyKey, hash, req, transaction),
      );
      if (result.replayed) paymentReplays.inc();
      else paymentsTotal.inc({ outcome: result.httpStatus === 201 ? 'success' : 'failed' });
      if (!result.replayed && result.httpStatus === 201) {
        bookingsConfirmed.inc();
        await this.cache.invalidate('reports', 'shows');
      }
      return result;
    });
  }

  private async payInTransaction(
    user: AuthUser,
    key: string,
    hash: string,
    req: PaymentRequest,
    transaction: Transaction,
  ): Promise<PaymentResult> {
    // Lock order: booking row FIRST (the payments FK would otherwise take a conflicting KEY SHARE lock
    // and deadlock concurrent attempts), then payment record, then seat rows ordered by id.
    const booking = await selectOne<BookingLock>(
      `SELECT id, user_id AS "userId", status, total_amount_minor AS total, currency,
              (hold_expires_at > clock_timestamp()) AS "holdValid"
         FROM bookings WHERE id = $1 FOR UPDATE`,
      [req.bookingId],
      transaction,
    );
    if (!booking) throw notFound('Booking');
    const inserted = await execute<{ id: string }>(
      `INSERT INTO payments (booking_id, user_id, idempotency_key, request_hash, amount_minor, status)
       VALUES ($1, $2, $3, $4, $5, 'PROCESSING')
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [req.bookingId, user.id, key, hash, req.amountMinor],
      transaction,
    );
    const paymentId = inserted[0]?.id;

    if (!paymentId) {
      const existing = await selectOne<PaymentRow>(
        `SELECT id, request_hash AS "requestHash", response_status AS "responseStatus",
                response_payload AS "responsePayload"
           FROM payments WHERE user_id = $1 AND idempotency_key = $2`,
        [user.id, key],
        transaction,
      );
      if (!existing) throw new AppError(409, 'CONFLICT', 'Idempotency record is not available, retry the request');
      if (existing.requestHash !== hash) {
        throw new AppError(409, 'IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used with a different request');
      }
      if (existing.responseStatus === null || existing.responsePayload === null) {
        throw new AppError(409, 'CONFLICT', 'The original request is still in progress');
      }
      return { httpStatus: existing.responseStatus, body: existing.responsePayload, replayed: true };
    }

    if (booking.status === 'CONFIRMED') throw new AppError(409, 'CONFLICT', 'This booking is already confirmed');
    if (booking.status !== 'HELD') throw new AppError(409, 'HOLD_EXPIRED', 'This booking can no longer be paid');
    if (!booking.holdValid) throw new AppError(409, 'HOLD_EXPIRED', 'Your seat hold has expired. Please select seats again.');
    if (booking.total !== req.amountMinor) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Payment amount does not match the booking total', {
        expectedAmountMinor: booking.total,
      });
    }

    const seats = await selectRows<{ id: string }>(
      `SELECT ss.id FROM show_seats ss
         JOIN booking_seats bs ON bs.show_seat_id = ss.id
        WHERE bs.booking_id = $1 AND ss.booking_id = $1 AND ss.status = 'HELD'
          AND ss.hold_expires_at > clock_timestamp()
        ORDER BY ss.id FOR UPDATE OF ss`,
      [booking.id],
      transaction,
    );
    const expected = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM booking_seats WHERE booking_id = $1', [booking.id], transaction);
    if (seats.length === 0 || seats.length !== expected?.n) {
      throw new AppError(409, 'HOLD_EXPIRED', 'Your seat hold has expired or was superseded. Please select seats again.');
    }

    const declined = req.cardNumber.endsWith(DECLINE_SUFFIX);
    if (declined) {
      const body = {
        status: 'FAILED',
        code: 'PAYMENT_DECLINED',
        message: 'The mock payment was declined. Your seats stay held until the timer expires.',
        bookingId: booking.id,
        paymentId,
      };
      await this.persist(paymentId, 'FAILED', 402, body, null, transaction);
      return { httpStatus: 402, body, replayed: false };
    }

    const reference = transactionReference();
    await execute(
      `UPDATE show_seats SET status = 'BOOKED', hold_token = NULL, hold_expires_at = NULL WHERE id = ANY($1::uuid[])`,
      [seats.map((s) => s.id)],
      transaction,
    );
    await execute("UPDATE bookings SET status = 'CONFIRMED', updated_at = NOW() WHERE id = $1", [booking.id], transaction);
    await execute(
      `INSERT INTO tickets (booking_id, ticket_number) VALUES ($1, $2) ON CONFLICT (booking_id) DO NOTHING`,
      [booking.id, ticketNumber()],
      transaction,
    );
    const ticket = await selectOne<{ id: string; ticketNumber: string }>(
      'SELECT id, ticket_number AS "ticketNumber" FROM tickets WHERE booking_id = $1',
      [booking.id],
      transaction,
    );
    const body = {
      status: 'SUCCESS',
      paymentId,
      transactionReference: reference,
      amountMinor: booking.total,
      currency: booking.currency,
      bookingId: booking.id,
      ticketId: ticket!.id,
      ticketNumber: ticket!.ticketNumber,
    };
    await this.persist(paymentId, 'SUCCESS', 201, body, reference, transaction);
    return { httpStatus: 201, body, replayed: false };
  }

  private persist(
    id: string,
    status: 'SUCCESS' | 'FAILED',
    httpStatus: number,
    body: Record<string, unknown>,
    reference: string | null,
    transaction: Transaction,
  ) {
    return execute(
      `UPDATE payments SET status = $2, response_status = $3, response_payload = $4::jsonb,
              transaction_reference = $5, updated_at = NOW() WHERE id = $1`,
      [id, status, httpStatus, JSON.stringify(body), reference],
      transaction,
    );
  }
}
