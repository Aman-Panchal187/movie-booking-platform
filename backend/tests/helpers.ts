import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Express } from 'express';
import request from 'supertest';
import { AppOptions, createApp } from '../src/app';
import { MemoryClient } from '../src/shared/cache/clients';
import { execute, selectOne, sequelize } from '../src/shared/database/sequelize';
import { AccountStatus, Role, signToken } from '../src/shared/middleware/auth';

export const PASSWORD = 'Passw0rd!test';

const HIGH_LIMITS = { read: 100000, login: 100000, loginPerEmail: 100000, register: 100000, hold: 100000, payment: 100000, admin: 100000, upload: 100000, submit: 100000 };

export function buildApp(options: AppOptions = {}) {
  const cacheClient = options.cacheClient ?? new MemoryClient();
  return { ...createApp({ limits: HIGH_LIMITS, ...options, cacheClient }), memory: cacheClient as MemoryClient };
}

export async function resetData(): Promise<void> {
  await sequelize.query(
    `TRUNCATE approval_audit_logs, tickets, payments, booking_seats, show_seats, bookings, shows, seats, screens,
              theatre_manager_assignments, theatres, movies, users RESTART IDENTITY CASCADE`,
  );
}

export interface TestUser {
  id: string;
  email: string;
  role: Role;
  token: string;
}

let counter = 0;
const hash = bcrypt.hashSync(PASSWORD, 4);

export async function createUser(role: Role, status: AccountStatus = 'ACTIVE', email?: string): Promise<TestUser> {
  counter += 1;
  const address = email ?? `${role.toLowerCase()}-${counter}-${randomUUID().slice(0, 6)}@test.dev`;
  const row = await selectOne<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, account_status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [`Test ${role} ${counter}`, address, hash, role, status],
  );
  return { id: row!.id, email: address, role, token: signToken({ id: row!.id, role }) };
}

export async function createMovie(durationMinutes = 120): Promise<string> {
  const row = await selectOne<{ id: string }>(
    `INSERT INTO movies (title, description, language, genre, duration_minutes) VALUES ($1,'d','English','Drama',$2) RETURNING id`,
    [`Movie ${randomUUID().slice(0, 6)}`, durationMinutes],
  );
  return row!.id;
}

export interface Venue {
  theatreId: string;
  screenId: string;
  movieId: string;
  showId: string;
  showSeatIds: string[];
}

/** An APPROVED theatre with one screen (rows x per seats) and one future show, assigned to `manager`. */
export async function createVenue(manager: TestUser, opts: { rows?: number; per?: number; status?: string; startOffsetHours?: number } = {}): Promise<Venue> {
  const rows = opts.rows ?? 2;
  const per = opts.per ?? 5;
  const theatre = await selectOne<{ id: string }>(
    `INSERT INTO theatres (name, city, address, contact_number, approval_status, submitted_by)
     VALUES ($1,'Testville','1 Test Street','+91 1234567890',$2,$3) RETURNING id`,
    [`Theatre ${randomUUID().slice(0, 6)}`, opts.status ?? 'APPROVED', manager.id],
  );
  await execute('INSERT INTO theatre_manager_assignments (manager_id, theatre_id, assigned_by) VALUES ($1,$2,$1)', [manager.id, theatre!.id]);
  const screen = await selectOne<{ id: string }>("INSERT INTO screens (theatre_id, name) VALUES ($1,'Screen 1') RETURNING id", [theatre!.id]);
  await execute(
    `INSERT INTO seats (screen_id, row_label, seat_number, seat_type)
     SELECT $1, chr(64 + r), n, 'STANDARD' FROM generate_series(1,$2::int) r, generate_series(1,$3::int) n`,
    [screen!.id, rows, per],
  );
  const movieId = await createMovie();
  const show = await selectOne<{ id: string }>(
    `INSERT INTO shows (movie_id, screen_id, start_time, end_time)
     VALUES ($1,$2, NOW() + ($3::int * INTERVAL '1 hour'), NOW() + ($3::int * INTERVAL '1 hour') + INTERVAL '2 hours') RETURNING id`,
    [movieId, screen!.id, opts.startOffsetHours ?? 24],
  );
  await execute(
    `INSERT INTO show_seats (show_id, seat_id, price_minor) SELECT $1, id, 20000 FROM seats WHERE screen_id = $2`,
    [show!.id, screen!.id],
  );
  const seats = await sequelize.query('SELECT ss.id FROM show_seats ss JOIN seats s ON s.id = ss.seat_id WHERE ss.show_id = $1 ORDER BY s.row_label, s.seat_number', {
    bind: [show!.id],
    type: 'SELECT',
  });
  return {
    theatreId: theatre!.id,
    screenId: screen!.id,
    movieId,
    showId: show!.id,
    showSeatIds: (seats as { id: string }[]).map((s) => s.id),
  };
}

export const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

export function hold(app: Express, user: TestUser, showId: string, showSeatIds: string[]) {
  return request(app).post('/api/bookings/hold').set(auth(user)).send({ showId, showSeatIds });
}

export function pay(
  app: Express,
  user: TestUser,
  key: string,
  body: { bookingId: string; amountMinor: number; cardNumber?: string; cardHolder?: string },
) {
  return request(app)
    .post('/api/payments')
    .set(auth(user))
    .set('Idempotency-Key', key)
    .send({ cardNumber: '4242424242424242', cardHolder: 'Test User', ...body });
}

/** Moves a hold's expiry into the past, simulating the passage of time on the database clock. */
export async function expireHold(bookingId: string): Promise<void> {
  await execute("UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [bookingId]);
  await execute("UPDATE show_seats SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE booking_id = $1 AND status = 'HELD'", [bookingId]);
}
