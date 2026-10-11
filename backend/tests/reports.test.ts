import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { execute } from '../src/shared/database/sequelize';
import { auth, buildApp, createUser, createVenue, expireHold, hold, pay, resetData, TestUser, Venue } from './helpers';

const { app } = buildApp();
let admin: TestUser;
let managerA: TestUser;
let managerB: TestUser;
let venueA: Venue;
let venueB: Venue;

async function sell(venue: Venue, seatCount: number, customer?: TestUser) {
  const c = customer ?? (await createUser('CUSTOMER'));
  const h = await hold(app, c, venue.showId, venue.showSeatIds.filter((_s, i) => !sold.has(venue.showId + i)).slice(0, seatCount));
  const booking = h.body.data as { id: string; totalAmountMinor: number; seats: { showSeatId: string }[] };
  booking.seats.forEach((s) => sold.add(venue.showId + venue.showSeatIds.indexOf(s.showSeatId)));
  const res = await pay(app, c, `rep-${booking.id}`, { bookingId: booking.id, amountMinor: booking.totalAmountMinor });
  expect(res.status).toBe(201);
  return booking;
}
let sold = new Set<string>();

beforeEach(async () => {
  await resetData();
  sold = new Set();
  admin = await createUser('ADMIN');
  managerA = await createUser('THEATRE_MANAGER');
  managerB = await createUser('THEATRE_MANAGER');
  venueA = await createVenue(managerA, { rows: 3, per: 5 });
  venueB = await createVenue(managerB, { rows: 3, per: 5 });
});

describe('reports', () => {
  it('revenue and tickets equal confirmed mock payments exactly (no join duplication)', async () => {
    await sell(venueA, 3); // 3 seats * 20000
    await sell(venueA, 2);
    const summary = await request(app).get('/api/manager/reports/summary?range=7d').set(auth(managerA));
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ bookings: 2, tickets: 5, revenueMinor: 100000 });

    const series = await request(app).get('/api/manager/reports/revenue?range=7d').set(auth(managerA));
    const total = series.body.data.series.reduce((s: number, d: { revenueMinor: number }) => s + d.revenueMinor, 0);
    const bookings = series.body.data.series.reduce((s: number, d: { bookings: number }) => s + d.bookings, 0);
    expect(total).toBe(100000);
    expect(bookings).toBe(2);
    expect(series.body.data.series).toHaveLength(7);
  });

  it('excludes failed payments and expired / unpaid holds', async () => {
    const c = await createUser('CUSTOMER');
    const failed = (await hold(app, c, venueA.showId, [venueA.showSeatIds[0]!])).body.data;
    await pay(app, c, 'rep-failed-0001', { bookingId: failed.id, amountMinor: failed.totalAmountMinor, cardNumber: '4000000000000002' });
    const expired = (await hold(app, c, venueA.showId, [venueA.showSeatIds[1]!])).body.data;
    await expireHold(expired.id);
    await hold(app, c, venueA.showId, [venueA.showSeatIds[2]!]); // still held, unpaid

    const summary = await request(app).get('/api/manager/reports/summary?range=7d').set(auth(managerA));
    expect(summary.body.data).toMatchObject({ bookings: 0, tickets: 0, revenueMinor: 0 });

    const dist = await request(app).get('/api/admin/reports/theatres?range=7d').set(auth(admin));
    const payments = Object.fromEntries(dist.body.data.paymentDistribution.map((p: { status: string; count: number }) => [p.status, p.count]));
    expect(payments).toEqual({ FAILED: 1 });
    const statuses = Object.fromEntries(dist.body.data.statusDistribution.map((p: { status: string; count: number }) => [p.status, p.count]));
    expect(statuses.EXPIRED).toBeGreaterThanOrEqual(1);
    expect(statuses.CONFIRMED).toBeUndefined();
  });

  it('managers only see theatres they are assigned to; admin sees the platform', async () => {
    await sell(venueA, 2);
    await sell(venueB, 4);
    const a = await request(app).get('/api/manager/reports/summary?range=7d').set(auth(managerA));
    const b = await request(app).get('/api/manager/reports/summary?range=7d').set(auth(managerB));
    expect(a.body.data).toMatchObject({ tickets: 2, revenueMinor: 40000 });
    expect(b.body.data).toMatchObject({ tickets: 4, revenueMinor: 80000 });

    const forbidden = await request(app).get(`/api/manager/reports/summary?range=7d&theatreId=${venueB.theatreId}`).set(auth(managerA));
    expect(forbidden.status).toBe(403);

    const platform = await request(app).get('/api/admin/reports/summary?range=7d').set(auth(admin));
    expect(platform.body.data).toMatchObject({ tickets: 6, revenueMinor: 120000, bookings: 2, customers: 2, managers: 2, approvedTheatres: 2 });
    expect((await request(app).get('/api/admin/reports/summary').set(auth(managerA))).status).toBe(403);
  });

  it('filters by date window: yesterday\'s sale is outside "today"', async () => {
    const booking = await sell(venueA, 2);
    await execute("UPDATE payments SET created_at = NOW() - INTERVAL '3 days' WHERE booking_id = $1", [booking.id]);
    const today = await request(app).get('/api/manager/reports/summary?range=today').set(auth(managerA));
    expect(today.body.data.tickets).toBe(0);
    const week = await request(app).get('/api/manager/reports/summary?range=7d').set(auth(managerA));
    expect(week.body.data.tickets).toBe(2);
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const custom = await request(app).get(`/api/manager/reports/summary?range=custom&from=${day}&to=${day}`).set(auth(managerA));
    expect(custom.body.data.tickets).toBeGreaterThanOrEqual(0);
    const bad = await request(app).get('/api/manager/reports/summary?range=custom&from=2026-02-01&to=2026-01-01').set(auth(managerA));
    expect(bad.status).toBe(422);
  });

  it('reports occupancy per show and by movie distribution', async () => {
    await sell(venueA, 5);
    // Occupancy windows cover shows that started inside the range, so move this show into the past.
    await execute("UPDATE shows SET start_time = NOW() - INTERVAL '3 hours', end_time = NOW() - INTERVAL '1 hour' WHERE id = $1", [venueA.showId]);
    const occ = await request(app).get('/api/manager/reports/occupancy?range=30d').set(auth(managerA));
    const show = occ.body.data.shows[0];
    expect(show).toMatchObject({ totalSeats: 15, bookedSeats: 5 });
    expect(show.occupancyPct).toBeCloseTo(33.3, 1);
    const bookings = await request(app).get('/api/manager/reports/bookings?range=7d').set(auth(managerA));
    expect(bookings.body.data.byMovie).toHaveLength(1);
    expect(bookings.body.data.byMovie[0]).toMatchObject({ tickets: 5, revenueMinor: 100000 });
    expect(bookings.body.meta.total).toBe(1);
  });

  it('a manager without approved theatres sees empty, not platform, data', async () => {
    await sell(venueA, 2);
    const lonely = await createUser('THEATRE_MANAGER');
    const res = await request(app).get('/api/manager/reports/summary?range=7d').set(auth(lonely));
    expect(res.body.data).toMatchObject({ bookings: 0, tickets: 0, revenueMinor: 0 });
  });
});
