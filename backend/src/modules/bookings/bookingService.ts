import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../shared/config/env';
import { execute, selectOne, selectRows, sequelize } from '../../shared/database/sequelize';
import { AppError, forbidden, notFound } from '../../shared/errors/errors';
import { AuthUser } from '../../shared/middleware/auth';
import { bookingConflicts, seatHolds } from '../../shared/observability/metrics';
import { withSpan } from '../../shared/observability/spans';
import { Page } from '../../shared/utils/http';

/*
 * Concurrency model (authoritative state is PostgreSQL only):
 *  - Rows for the requested show_seats are locked with SELECT ... FOR UPDATE in a fixed order (by id),
 *    so concurrent multi-seat requests cannot deadlock each other.
 *  - Seats are then claimed all-or-nothing in one transaction; any unavailable seat aborts everything.
 *  - Expiry is judged with the database clock (clock_timestamp()), never the application clock.
 *  - Expired holds are reclaimed lazily here: a HELD seat whose hold_expires_at has passed is simply
 *    treated as available. No timers or cron jobs are needed for correctness.
 */

const MAX_ACTIVE_HOLDS_PER_USER = 5;

interface LockedSeat {
  id: string;
  priceMinor: number;
  status: 'AVAILABLE' | 'HELD' | 'BOOKED';
  expired: boolean;
  showStatus: string;
  started: boolean;
  theatreStatus: string;
  screenActive: boolean;
}

const bookingReference = () => `BK${randomBytes(5).toString('hex').toUpperCase()}`;

export class BookingService {
  hold(user: AuthUser, showId: string, showSeatIds: string[]) {
    const ids = [...new Set(showSeatIds)];
    if (ids.length > env().MAX_SEATS_PER_BOOKING) {
      throw new AppError(422, 'VALIDATION_ERROR', `You can book at most ${env().MAX_SEATS_PER_BOOKING} seats at a time`);
    }
    return withSpan('booking.hold', { 'booking.show_id': showId, 'booking.seat_count': ids.length }, async () => {
      const bookingId = await sequelize.transaction(async (transaction) => {
        // Housekeeping for the caller's own stale holds, done first so lock order stays booking -> seats.
        await execute(
          `UPDATE bookings SET status = 'EXPIRED', updated_at = NOW()
            WHERE user_id = $1 AND status = 'HELD' AND hold_expires_at <= clock_timestamp()`,
          [user.id],
          transaction,
        );
        const active = await selectOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM bookings WHERE user_id = $1 AND status = 'HELD' AND hold_expires_at > clock_timestamp()`,
          [user.id],
          transaction,
        );
        if ((active?.n ?? 0) >= MAX_ACTIVE_HOLDS_PER_USER) {
          throw new AppError(409, 'CONFLICT', 'You have too many active seat holds. Complete or wait for them to expire.');
        }

        const seats = await selectRows<LockedSeat>(
          `SELECT ss.id, ss.price_minor AS "priceMinor", ss.status,
                  (ss.status = 'HELD' AND ss.hold_expires_at <= clock_timestamp()) AS expired,
                  sh.status AS "showStatus", (sh.start_time <= clock_timestamp()) AS started,
                  t.approval_status AS "theatreStatus", sc.is_active AS "screenActive"
             FROM show_seats ss
             JOIN shows sh ON sh.id = ss.show_id
             JOIN screens sc ON sc.id = sh.screen_id
             JOIN theatres t ON t.id = sc.theatre_id
            WHERE ss.show_id = $1 AND ss.id = ANY($2::uuid[])
            ORDER BY ss.id
              FOR UPDATE OF ss`,
          [showId, ids],
          transaction,
        );
        if (seats.length !== ids.length) throw notFound('One or more seats for this show');
        const first = seats[0]!;
        if (first.showStatus !== 'SCHEDULED' || first.started || first.theatreStatus !== 'APPROVED' || !first.screenActive) {
          throw new AppError(409, 'CONFLICT', 'This show is not open for booking');
        }
        const unavailable = seats.filter((s) => s.status === 'BOOKED' || (s.status === 'HELD' && !s.expired));
        if (unavailable.length > 0) {
          bookingConflicts.inc();
          throw new AppError(409, 'SEATS_UNAVAILABLE', 'One or more selected seats are no longer available', {
            unavailableShowSeatIds: unavailable.map((s) => s.id),
          });
        }

        const total = seats.reduce((sum, s) => sum + s.priceMinor, 0);
        const holdSeconds = env().HOLD_DURATION_SECONDS;
        const [booking] = await execute<{ id: string }>(
          `INSERT INTO bookings (user_id, show_id, booking_reference, total_amount_minor, status, hold_expires_at)
           VALUES ($1, $2, $3, $4, 'HELD', clock_timestamp() + ($5::int * INTERVAL '1 second'))
           RETURNING id`,
          [user.id, showId, bookingReference(), total, holdSeconds],
          transaction,
        );
        await execute(
          `INSERT INTO booking_seats (booking_id, show_seat_id, unit_price_minor)
           SELECT $1, id, price_minor FROM show_seats WHERE id = ANY($2::uuid[])`,
          [booking!.id, ids],
          transaction,
        );
        const claimed = await execute(
          `UPDATE show_seats
              SET status = 'HELD', hold_token = $3, booking_id = $1,
                  hold_expires_at = clock_timestamp() + ($4::int * INTERVAL '1 second')
            WHERE id = ANY($2::uuid[])
              AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= clock_timestamp()))
        RETURNING id`,
          [booking!.id, ids, randomUUID(), holdSeconds],
          transaction,
        );
        if (claimed.length !== ids.length) {
          // Defensive: rows are locked, so this should be unreachable. Roll everything back.
          bookingConflicts.inc();
          throw new AppError(409, 'SEATS_UNAVAILABLE', 'One or more selected seats are no longer available');
        }
        return booking!.id;
      });
      seatHolds.inc();
      return this.getForUser(user, bookingId);
    });
  }

  private static readonly SELECT = `
    SELECT b.id, b.booking_reference AS reference,
           CASE WHEN b.status = 'HELD' AND b.hold_expires_at <= NOW() THEN 'EXPIRED' ELSE b.status END AS status,
           b.total_amount_minor AS "totalAmountMinor", b.currency,
           b.hold_expires_at AS "holdExpiresAt", b.created_at AS "createdAt", NOW() AS "serverNow",
           b.user_id AS "userId",
           sh.id AS "showId", sh.start_time AS "startTime", sc.name AS "screenName",
           m.id AS "movieId", m.title AS "movieTitle", m.poster_url AS "posterUrl",
           t.id AS "theatreId", t.name AS "theatreName", t.city,
           tk.id AS "ticketId", tk.ticket_number AS "ticketNumber", tk.issued_at AS "ticketIssuedAt",
           (SELECT json_agg(json_build_object(
                     'showSeatId', ss.id, 'label', se.row_label || se.seat_number,
                     'seatType', se.seat_type, 'priceMinor', bs.unit_price_minor)
                   ORDER BY se.row_label, se.seat_number)
              FROM booking_seats bs
              JOIN show_seats ss ON ss.id = bs.show_seat_id
              JOIN seats se ON se.id = ss.seat_id
             WHERE bs.booking_id = b.id) AS seats
      FROM bookings b
      JOIN shows sh ON sh.id = b.show_id
      JOIN screens sc ON sc.id = sh.screen_id
      JOIN theatres t ON t.id = sc.theatre_id
      JOIN movies m ON m.id = sh.movie_id
      LEFT JOIN tickets tk ON tk.booking_id = b.id`;

  async getForUser(user: AuthUser, id: string) {
    const row = await selectOne<{ userId: string }>(`${BookingService.SELECT} WHERE b.id = $1`, [id]);
    if (!row) throw notFound('Booking');
    if (row.userId !== user.id && user.role !== 'ADMIN') throw forbidden('This booking belongs to another user');
    return row;
  }

  async listForUser(user: AuthUser, page: Page) {
    const rows = await selectRows(
      `${BookingService.SELECT} WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
      [user.id, page.limit, page.offset],
    );
    const total = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE user_id = $1', [user.id]);
    return { rows, total: total?.n ?? 0 };
  }

  async getTicket(user: AuthUser, ticketId: string) {
    const ticket = await selectOne<{ bookingId: string }>('SELECT booking_id AS "bookingId" FROM tickets WHERE id = $1', [
      ticketId,
    ]);
    if (!ticket) throw notFound('Ticket');
    return this.getForUser(user, ticket.bookingId);
  }
}
