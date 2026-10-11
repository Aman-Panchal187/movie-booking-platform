import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { selectOne } from '../src/shared/database/sequelize';
import { auth, buildApp, createUser, createVenue, expireHold, hold, pay, resetData, TestUser, Venue } from './helpers';

const { app } = buildApp();
let manager: TestUser;
let customer: TestUser;
let venue: Venue;

async function newHold(seatCount = 2) {
  const res = await hold(app, customer, venue.showId, venue.showSeatIds.slice(0, seatCount));
  expect(res.status).toBe(201);
  return res.body.data as { id: string; totalAmountMinor: number };
}

beforeEach(async () => {
  await resetData();
  manager = await createUser('THEATRE_MANAGER');
  customer = await createUser('CUSTOMER');
  venue = await createVenue(manager, { rows: 3, per: 5 });
});

describe('mock payments', () => {
  it('confirms the booking, books the seats and issues one ticket', async () => {
    const booking = await newHold();
    const res = await pay(app, customer, 'key-success-0001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('SUCCESS');
    expect(res.body.data.ticketNumber).toMatch(/^TKT-/);

    const detail = await request(app).get(`/api/bookings/${booking.id}`).set(auth(customer));
    expect(detail.body.data.status).toBe('CONFIRMED');
    expect(detail.body.data.ticketNumber).toBe(res.body.data.ticketNumber);
    const booked = await selectOne<{ n: number }>("SELECT COUNT(*) AS n FROM show_seats WHERE booking_id = $1 AND status = 'BOOKED'", [booking.id]);
    expect(booked?.n).toBe(2);

    const ticket = await request(app).get(`/api/tickets/${res.body.data.ticketId}`).set(auth(customer));
    expect(ticket.status).toBe(200);
    expect(ticket.body.data.seats).toHaveLength(2);
  });

  it('requires an Idempotency-Key header', async () => {
    const booking = await newHold();
    const res = await request(app).post('/api/payments').set(auth(customer))
      .send({ bookingId: booking.id, amountMinor: booking.totalAmountMinor, cardNumber: '4242424242424242', cardHolder: 'A B' });
    expect(res.status).toBe(422);
  });

  it('rejects an unknown booking and another user\'s booking', async () => {
    const booking = await newHold();
    const stranger = await createUser('CUSTOMER');
    expect((await pay(app, stranger, 'key-stranger-001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor })).status).toBe(403);
    expect((await pay(app, customer, 'key-unknown-0001', { bookingId: '00000000-0000-4000-8000-000000000000', amountMinor: 1 })).status).toBe(404);
  });

  it('rejects a wrong amount without side effects', async () => {
    const booking = await newHold();
    const res = await pay(app, customer, 'key-amount-0001', { bookingId: booking.id, amountMinor: 1 });
    expect(res.status).toBe(422);
    const payments = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM payments', []);
    expect(payments?.n).toBe(0);
  });

  it('rejects payment for an expired hold and leaves nothing confirmed', async () => {
    const booking = await newHold();
    await expireHold(booking.id);
    const res = await pay(app, customer, 'key-expired-0001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    const tickets = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM tickets', []);
    expect(tickets?.n).toBe(0);
  });

  it('rejects payment for a hold superseded by another customer', async () => {
    const booking = await newHold(1);
    await expireHold(booking.id);
    const other = await createUser('CUSTOMER');
    expect((await hold(app, other, venue.showId, [venue.showSeatIds[0]!])).status).toBe(201);
    const res = await pay(app, customer, 'key-superseded-1', { bookingId: booking.id, amountMinor: booking.totalAmountMinor });
    expect(res.status).toBe(409);
  });

  it('replays the original result for the same key and payload', async () => {
    const booking = await newHold();
    const body = { bookingId: booking.id, amountMinor: booking.totalAmountMinor };
    const first = await pay(app, customer, 'key-replay-00001', body);
    const second = await pay(app, customer, 'key-replay-00001', body);
    expect(second.status).toBe(first.status);
    expect(second.body.data.paymentId).toBe(first.body.data.paymentId);
    expect(second.body.data.ticketNumber).toBe(first.body.data.ticketNumber);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const counts = await selectOne<{ p: number; t: number }>('SELECT (SELECT COUNT(*) FROM payments) AS p, (SELECT COUNT(*) FROM tickets) AS t', []);
    expect(counts).toEqual({ p: 1, t: 1 });
  });

  it('rejects the same key with a different payload (409)', async () => {
    const booking = await newHold();
    await pay(app, customer, 'key-mismatch-001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor });
    const other = await newHold(1).catch(() => null);
    const res = await pay(app, customer, 'key-mismatch-001', { bookingId: other?.id ?? booking.id, amountMinor: (other?.totalAmountMinor ?? booking.totalAmountMinor) + 100 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('creates exactly one logical payment for concurrent duplicate requests', async () => {
    const booking = await newHold();
    const body = { bookingId: booking.id, amountMinor: booking.totalAmountMinor };
    const results = await Promise.all(Array.from({ length: 12 }, () => pay(app, customer, 'key-concurrent-01', body)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.paymentId)).size).toBe(1);
    const counts = await selectOne<{ p: number; t: number; c: number }>(
      "SELECT (SELECT COUNT(*) FROM payments) AS p, (SELECT COUNT(*) FROM tickets) AS t, (SELECT COUNT(*) FROM bookings WHERE status = 'CONFIRMED') AS c", []);
    expect(counts).toEqual({ p: 1, t: 1, c: 1 });
  });

  it('with different keys, a booking can only be confirmed once', async () => {
    const booking = await newHold();
    const body = { bookingId: booking.id, amountMinor: booking.totalAmountMinor };
    const results = await Promise.all(Array.from({ length: 8 }, (_v, i) => pay(app, customer, `key-diff-${i}-abcdef`, body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const counts = await selectOne<{ p: number; t: number }>("SELECT (SELECT COUNT(*) FROM payments WHERE status = 'SUCCESS') AS p, (SELECT COUNT(*) FROM tickets) AS t", []);
    expect(counts).toEqual({ p: 1, t: 1 });
  });

  it('a declined payment does not confirm the booking and keeps seat state intact', async () => {
    const booking = await newHold();
    const res = await pay(app, customer, 'key-decline-0001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor, cardNumber: '4000000000000002' });
    expect(res.status).toBe(402);
    expect(res.body.data.code).toBe('PAYMENT_DECLINED');
    const state = await selectOne<{ status: string; held: number; tickets: number }>(
      `SELECT b.status, (SELECT COUNT(*) FROM show_seats WHERE booking_id = b.id AND status = 'HELD') AS held,
              (SELECT COUNT(*) FROM tickets) AS tickets FROM bookings b WHERE b.id = $1`, [booking.id]);
    expect(state).toEqual({ status: 'HELD', held: 2, tickets: 0 });

    // Replaying the declined key returns the same decline; a fresh key can still succeed.
    expect((await pay(app, customer, 'key-decline-0001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor, cardNumber: '4000000000000002' })).status).toBe(402);
    const retry = await pay(app, customer, 'key-decline-0002', { bookingId: booking.id, amountMinor: booking.totalAmountMinor });
    expect(retry.status).toBe(201);
  });

  it('confirmed seats stay booked and cannot be re-held', async () => {
    const booking = await newHold();
    await pay(app, customer, 'key-booked-00001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor });
    const other = await createUser('CUSTOMER');
    expect((await hold(app, other, venue.showId, venue.showSeatIds.slice(0, 2))).status).toBe(409);
  });

  it('a payment racing a hold expiry never oversells', async () => {
    const booking = await newHold(1);
    await expireHold(booking.id);
    const other = await createUser('CUSTOMER');
    const [payRes, holdRes] = await Promise.all([
      pay(app, customer, 'key-race-000001', { bookingId: booking.id, amountMinor: booking.totalAmountMinor }),
      hold(app, other, venue.showId, [venue.showSeatIds[0]!]),
    ]);
    expect(payRes.status).toBe(409);
    expect(holdRes.status).toBe(201);
    const owners = await selectOne<{ n: number }>("SELECT COUNT(DISTINCT booking_id) AS n FROM show_seats WHERE id = $1", [venue.showSeatIds[0]]);
    expect(owners?.n).toBe(1);
  });
});
