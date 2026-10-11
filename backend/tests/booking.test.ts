import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BookingService } from '../src/modules/bookings/bookingService';
import { execute, selectOne, selectRows } from '../src/shared/database/sequelize';
import { AuthUser } from '../src/shared/middleware/auth';
import { buildApp, createUser, createVenue, expireHold, hold, resetData, TestUser, Venue, auth } from './helpers';

const { app } = buildApp();
const asAuthUser = (u: TestUser): AuthUser => ({ id: u.id, name: u.email, email: u.email, role: u.role, accountStatus: 'ACTIVE', rejectionReason: null });

let manager: TestUser;
let venue: Venue;

beforeAll(resetData);
beforeEach(async () => {
  await resetData();
  manager = await createUser('THEATRE_MANAGER');
  venue = await createVenue(manager, { rows: 2, per: 5 });
});

describe('seat holds', () => {
  it('holds an available seat and shows it as HELD in the seat map', async () => {
    const customer = await createUser('CUSTOMER');
    const res = await hold(app, customer, venue.showId, [venue.showSeatIds[0]!]);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('HELD');
    expect(res.body.data.totalAmountMinor).toBe(20000);

    const map = await request(app).get(`/api/shows/${venue.showId}/seats`);
    const held = map.body.data.seats.filter((s: { status: string }) => s.status === 'HELD');
    expect(held).toHaveLength(1);
  });

  it('holds multiple seats atomically', async () => {
    const customer = await createUser('CUSTOMER');
    const res = await hold(app, customer, venue.showId, venue.showSeatIds.slice(0, 3));
    expect(res.status).toBe(201);
    expect(res.body.data.seats).toHaveLength(3);
    expect(res.body.data.totalAmountMinor).toBe(60000);
  });

  it('refuses a second customer for the same seat (409)', async () => {
    const [a, b] = [await createUser('CUSTOMER'), await createUser('CUSTOMER')];
    expect((await hold(app, a, venue.showId, [venue.showSeatIds[0]!])).status).toBe(201);
    const res = await hold(app, b, venue.showId, [venue.showSeatIds[0]!]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');
  });

  it('rolls back a partially available multi-seat request (all or nothing)', async () => {
    const [a, b] = [await createUser('CUSTOMER'), await createUser('CUSTOMER')];
    await hold(app, a, venue.showId, [venue.showSeatIds[1]!]);
    const res = await hold(app, b, venue.showId, [venue.showSeatIds[0]!, venue.showSeatIds[1]!, venue.showSeatIds[2]!]);
    expect(res.status).toBe(409);
    const stillAvailable = await selectRows<{ status: string }>("SELECT status FROM show_seats WHERE id = ANY($1::uuid[])", [[venue.showSeatIds[0], venue.showSeatIds[2]]]);
    expect(stillAvailable.every((s) => s.status === 'AVAILABLE')).toBe(true);
    const bookings = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE user_id = $1', [b.id]);
    expect(bookings?.n).toBe(0);
  });

  it('100 concurrent attempts for the same seat produce exactly one winner', async () => {
    const customers = await Promise.all(Array.from({ length: 100 }, () => createUser('CUSTOMER')));
    const service = new BookingService();
    const outcomes = await Promise.allSettled(customers.map((c) => service.hold(asAuthUser(c), venue.showId, [venue.showSeatIds[0]!])));
    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losers = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(99);
    expect(losers.every((l) => (l.reason as { status?: number }).status === 409)).toBe(true);
    const held = await selectOne<{ n: number }>("SELECT COUNT(*) AS n FROM show_seats WHERE show_id = $1 AND status = 'HELD'", [venue.showId]);
    expect(held?.n).toBe(1);
  });

  it('overlapping multi-seat requests in opposite order never deadlock or double-book', async () => {
    const customers = await Promise.all(Array.from({ length: 20 }, () => createUser('CUSTOMER')));
    const service = new BookingService();
    const [s0, s1, s2, s3] = venue.showSeatIds;
    const outcomes = await Promise.allSettled(
      customers.map((c, i) => service.hold(asAuthUser(c), venue.showId, i % 2 === 0 ? [s0!, s1!, s2!] : [s2!, s1!, s3!])),
    );
    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    expect(winners.length).toBe(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected.every((r) => (r.reason as { status?: number }).status === 409)).toBe(true);
  });

  it('reclaims an expired hold lazily, with no background job', async () => {
    const [a, b] = [await createUser('CUSTOMER'), await createUser('CUSTOMER')];
    const first = await hold(app, a, venue.showId, [venue.showSeatIds[0]!]);
    expect((await hold(app, b, venue.showId, [venue.showSeatIds[0]!])).status).toBe(409);
    await expireHold(first.body.data.id);

    const map = await request(app).get(`/api/shows/${venue.showId}/seats`);
    expect(map.body.data.seats.find((s: { showSeatId: string }) => s.showSeatId === venue.showSeatIds[0]).status).toBe('AVAILABLE');

    const second = await hold(app, b, venue.showId, [venue.showSeatIds[0]!]);
    expect(second.status).toBe(201);
    const row = await selectOne<{ booking_id: string }>('SELECT booking_id FROM show_seats WHERE id = $1', [venue.showSeatIds[0]]);
    expect(row?.booking_id).toBe(second.body.data.id);
  });

  it('never overwrites a confirmed (BOOKED) seat even if hold_expires_at is stale', async () => {
    const [a, b] = [await createUser('CUSTOMER'), await createUser('CUSTOMER')];
    const first = await hold(app, a, venue.showId, [venue.showSeatIds[0]!]);
    await execute("UPDATE show_seats SET status = 'BOOKED', hold_token = NULL, hold_expires_at = NULL WHERE booking_id = $1", [first.body.data.id]);
    const res = await hold(app, b, venue.showId, [venue.showSeatIds[0]!]);
    expect(res.status).toBe(409);
  });

  it('rejects seats from a different show and unknown seat ids', async () => {
    const customer = await createUser('CUSTOMER');
    const otherManager = await createUser('THEATRE_MANAGER');
    const other = await createVenue(otherManager);
    const res = await hold(app, customer, venue.showId, [other.showSeatIds[0]!]);
    expect(res.status).toBe(404);
  });

  it('does not allow holding seats of a show in a pending theatre', async () => {
    const pendingManager = await createUser('THEATRE_MANAGER');
    const pending = await createVenue(pendingManager, { status: 'PENDING_APPROVAL' });
    const customer = await createUser('CUSTOMER');
    expect((await hold(app, customer, pending.showId, [pending.showSeatIds[0]!])).status).toBe(409);
  });

  it('denies other users access to a booking and requires authentication', async () => {
    const [a, b] = [await createUser('CUSTOMER'), await createUser('CUSTOMER')];
    const booking = await hold(app, a, venue.showId, [venue.showSeatIds[0]!]);
    expect((await request(app).get(`/api/bookings/${booking.body.data.id}`).set(auth(b))).status).toBe(403);
    expect((await request(app).get(`/api/bookings/${booking.body.data.id}`)).status).toBe(401);
    expect((await request(app).get(`/api/bookings/${booking.body.data.id}`).set(auth(a))).status).toBe(200);
  });

  it('applies the database CHECK/UNIQUE invariants even to direct writes', async () => {
    await expect(
      execute("UPDATE show_seats SET status = 'BOOKED' WHERE id = $1", [venue.showSeatIds[0]]),
    ).rejects.toThrow();
  });
});
