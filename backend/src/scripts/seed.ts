import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Transaction } from 'sequelize';
import { env } from '../shared/config/env';
import { execute, selectOne, selectRows, sequelize } from '../shared/database/sequelize';
import { logger } from '../shared/logging/logger';

/*
 * Idempotent demo seed. Everything here is SYNTHETIC demo data:
 *  - fictional movies, with open-licence (CC-BY, Blender Foundation) trailers and photo placeholders
 *  - accounts on *.invalid / *.local domains whose passwords are random and never printed,
 *    unless DEMO_PASSWORD is provided for LOCAL development (refused in production)
 *  - historical bookings/payments for report charts, flagged by the @demo.invalid customer domain
 * Re-running tops up upcoming shows and never touches real bookings.
 */

const SLOTS = ['10:00', '14:30', '19:00'];
const PRICES = { STANDARD: 25000, PREMIUM: 35000, RECLINER: 55000 };
const HISTORY_DAYS = 21;

const MOVIES = [
  { title: 'Midnight Orbit', genre: 'Sci-Fi', language: 'English', min: 128, cert: 'UA', seed: 'orbit', trailer: 'R6MlUcmOul8', desc: 'A salvage crew drifting past Neptune finds a signal that should not exist. A synthetic demo title.' },
  { title: 'The Last Lighthouse', genre: 'Drama', language: 'English', min: 112, cert: 'U', seed: 'lighthouse', trailer: 'eRsGyueVLvQ', desc: 'The final keeper of a storm-battered lighthouse hosts an unexpected guest. A synthetic demo title.' },
  { title: 'Neon Monsoon', genre: 'Thriller', language: 'Hindi', min: 136, cert: 'UA', seed: 'monsoon', trailer: 'aqz-KE-bpKQ', desc: 'Over one rain-soaked night, a courier uncovers the city\'s best-kept secret. A synthetic demo title.' },
  { title: 'Paper Kingdoms', genre: 'Animation', language: 'English', min: 98, cert: 'U', seed: 'kingdoms', trailer: 'TLkA0RELQ1g', desc: 'Two origami rivals must unite to save a folded world. A synthetic demo title.' },
];

const THEATRES = [
  { name: 'Aurora Cinemas', city: 'Mumbai', address: '12 Marine Drive, Mumbai 400020', phone: '+91 22 5550 0101', screens: [{ name: 'Screen 1', rows: 8, per: 12, prem: 2, rec: 1 }, { name: 'Screen 2', rows: 6, per: 10, prem: 1, rec: 0 }] },
  { name: 'Skyline Multiplex', city: 'Bengaluru', address: '88 MG Road, Bengaluru 560001', phone: '+91 80 5550 0202', screens: [{ name: 'Audi A', rows: 8, per: 14, prem: 2, rec: 2 }] },
  { name: 'Riverside Screens', city: 'Delhi', address: '5 Connaught Place, New Delhi 110001', phone: '+91 11 5550 0303', screens: [{ name: 'Hall 1', rows: 7, per: 12, prem: 2, rec: 1 }] },
];

const randomHash = () => bcrypt.hash(randomBytes(24).toString('hex'), 4);

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function upsertUser(name: string, email: string, role: string, status: string, hash: string): Promise<string> {
  await execute(
    `INSERT INTO users (name, email, password_hash, role, account_status) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (LOWER(email)) DO NOTHING`,
    [name, email, hash, role, status],
  );
  const row = await selectOne<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  return row!.id;
}

async function seedMovies(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const m of MOVIES) {
    const existing = await selectOne<{ id: string }>('SELECT id FROM movies WHERE title = $1', [m.title]);
    if (existing) {
      ids[m.title] = existing.id;
      continue;
    }
    const [row] = await execute<{ id: string }>(
      `INSERT INTO movies (title, description, language, genre, duration_minutes, release_date, certification,
                           poster_url, banner_url, trailer_url)
       VALUES ($1,$2,$3,$4,$5, CURRENT_DATE - 14, $6, $7, $8, $9) RETURNING id`,
      [m.title, m.desc, m.language, m.genre, m.min, m.cert,
        `https://picsum.photos/seed/${m.seed}-poster/600/900`, `https://picsum.photos/seed/${m.seed}-banner/1600/700`,
        `https://www.youtube-nocookie.com/embed/${m.trailer}`],
    );
    ids[m.title] = row!.id;
  }
  return ids;
}

async function seedTheatres(managerId: string): Promise<string[]> {
  const screenIds: string[] = [];
  for (const t of THEATRES) {
    let theatre = await selectOne<{ id: string }>('SELECT id FROM theatres WHERE name = $1 AND city = $2', [t.name, t.city]);
    if (!theatre) {
      const [row] = await execute<{ id: string }>(
        `INSERT INTO theatres (name, city, address, contact_number, description, approval_status, submitted_by, reviewed_at)
         VALUES ($1,$2,$3,$4,'Demo theatre (synthetic data)','APPROVED',$5,NOW()) RETURNING id`,
        [t.name, t.city, t.address, t.phone, managerId],
      );
      theatre = row!;
    }
    await execute(
      `INSERT INTO theatre_manager_assignments (manager_id, theatre_id, assigned_by) VALUES ($1,$2,$1)
       ON CONFLICT (manager_id, theatre_id) DO NOTHING`,
      [managerId, theatre.id],
    );
    for (const s of t.screens) {
      let screen = await selectOne<{ id: string }>('SELECT id FROM screens WHERE theatre_id = $1 AND name = $2', [theatre.id, s.name]);
      if (!screen) {
        const [row] = await execute<{ id: string }>('INSERT INTO screens (theatre_id, name) VALUES ($1,$2) RETURNING id', [theatre.id, s.name]);
        screen = row!;
        await execute(
          `INSERT INTO seats (screen_id, row_label, seat_number, seat_type)
           SELECT $1, chr(64 + r), n,
                  CASE WHEN r > $3::int - $5::int THEN 'RECLINER'
                       WHEN r > $3::int - $5::int - $4::int THEN 'PREMIUM' ELSE 'STANDARD' END
             FROM generate_series(1, $3::int) r, generate_series(1, $2::int) n`,
          [screen.id, s.per, s.rows, s.prem, s.rec],
        );
      }
      screenIds.push(screen.id);
    }
  }
  return screenIds;
}

/** Upcoming shows for the next 7 IST days; skips slots that already exist or overlap. */
async function seedUpcomingShows(screenIds: string[], movieIds: string[]) {
  let created = 0;
  for (let day = 0; day < 7; day += 1) {
    for (let slot = 0; slot < SLOTS.length; slot += 1) {
      for (let si = 0; si < screenIds.length; si += 1) {
        const movieId = movieIds[(day + slot + si) % movieIds.length]!;
        const startSql = `(((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $3::int)::timestamp + $4::time) AT TIME ZONE 'Asia/Kolkata'`;
        const ok = await sequelize.transaction(async (tx) => {
          const id = await insertShowWithBind(screenIds[si]!, movieId, startSql, [day, SLOTS[slot]], tx);
          return id !== null;
        });
        if (ok) created += 1;
      }
    }
  }
  return created;
}

async function insertShowWithBind(screenId: string, movieId: string, startSql: string, extra: unknown[], tx: Transaction) {
  const rows = await execute<{ id: string }>(
    `INSERT INTO shows (movie_id, screen_id, start_time, end_time)
     SELECT $1, $2, s.start, s.start + ((SELECT duration_minutes FROM movies WHERE id = $1) + 20) * INTERVAL '1 minute'
       FROM (SELECT ${startSql} AS start) s
      WHERE s.start > NOW()
     ON CONFLICT DO NOTHING RETURNING id`,
    [movieId, screenId, ...extra],
    tx,
  );
  const id = rows[0]?.id;
  if (!id) return null;
  await execute(
    `INSERT INTO show_seats (show_id, seat_id, price_minor)
     SELECT $1, se.id, CASE se.seat_type WHEN 'RECLINER' THEN $4::bigint WHEN 'PREMIUM' THEN $3::bigint ELSE $2::bigint END
       FROM seats se WHERE se.screen_id = $5`,
    [id, PRICES.STANDARD, PRICES.PREMIUM, PRICES.RECLINER, screenId],
    tx,
  );
  return id;
}

/** Past shows with confirmed bookings so manager/admin charts have consistent, clearly-demo data. */
async function seedHistory(screenIds: string[], movieIds: string[]) {
  const marker = await selectOne('SELECT 1 AS x FROM users WHERE email LIKE $1 LIMIT 1', ['%@demo.invalid']);
  const already = marker
    ? await selectOne("SELECT 1 AS x FROM bookings b JOIN users u ON u.id = b.user_id WHERE u.email LIKE '%@demo.invalid' AND u.email LIKE 'demo.customer%' LIMIT 1")
    : null;
  if (already) return 0;

  const hash = await randomHash();
  const customers: string[] = [];
  for (let i = 1; i <= 12; i += 1) {
    customers.push(await upsertUser(`Demo Customer ${i}`, `demo.customer${String(i).padStart(2, '0')}@demo.invalid`, 'CUSTOMER', 'ACTIVE', hash));
  }
  const rand = rng(20260101);
  let bookingsCreated = 0;

  for (let day = HISTORY_DAYS; day >= 1; day -= 1) {
    for (let si = 0; si < screenIds.length; si += 1) {
      for (const slot of [SLOTS[0]!, SLOTS[2]!]) {
        const movieId = movieIds[Math.floor(rand() * movieIds.length)]!;
        const startSql = `(((NOW() AT TIME ZONE 'Asia/Kolkata')::date - $3::int)::timestamp + $4::time) AT TIME ZONE 'Asia/Kolkata'`;
        await sequelize.transaction(async (tx) => {
          const rows = await execute<{ id: string }>(
            `INSERT INTO shows (movie_id, screen_id, start_time, end_time)
             SELECT $1, $2, s.start, s.start + ((SELECT duration_minutes FROM movies WHERE id = $1) + 20) * INTERVAL '1 minute'
               FROM (SELECT ${startSql} AS start) s
             ON CONFLICT DO NOTHING RETURNING id`,
            [movieId, screenIds[si], day, slot],
            tx,
          );
          const showId = rows[0]?.id;
          if (!showId) return;
          await execute(
            `INSERT INTO show_seats (show_id, seat_id, price_minor)
             SELECT $1, se.id, CASE se.seat_type WHEN 'RECLINER' THEN $4::bigint WHEN 'PREMIUM' THEN $3::bigint ELSE $2::bigint END
               FROM seats se WHERE se.screen_id = $5`,
            [showId, PRICES.STANDARD, PRICES.PREMIUM, PRICES.RECLINER, screenIds[si]],
            tx,
          );
          const seats = await selectRows<{ id: string; price: number }>(
            'SELECT id, price_minor AS price FROM show_seats WHERE show_id = $1 ORDER BY id',
            [showId],
            tx,
          );
          // Fisher-Yates with the seeded PRNG, then take a weekday/slot-dependent fill rate.
          for (let i = seats.length - 1; i > 0; i -= 1) {
            const j = Math.floor(rand() * (i + 1));
            [seats[i], seats[j]] = [seats[j]!, seats[i]!];
          }
          const fill = 0.2 + rand() * 0.55;
          const sold = seats.slice(0, Math.floor(seats.length * fill));
          const unsold = seats.slice(sold.length);

          const chunks: { id: string; price: number }[][] = [];
          let cursor = 0;
          while (cursor < sold.length) {
            const size = 1 + Math.floor(rand() * 3);
            chunks.push(sold.slice(cursor, cursor + size));
            cursor += size;
          }
          for (const chunk of chunks) {
            const total = chunk.reduce((s, x) => s + x.price, 0);
            const userId = customers[Math.floor(rand() * customers.length)]!;
            const hoursBefore = 2 + rand() * 46;
            const ref = `DM${randomBytes(4).toString('hex').toUpperCase()}`;
            const [b] = await execute<{ id: string }>(
              `INSERT INTO bookings (user_id, show_id, booking_reference, total_amount_minor, status, hold_expires_at, created_at, updated_at)
               SELECT $1, $2, $3, $4, 'CONFIRMED', sh.start_time - ($5::float * INTERVAL '1 hour') + INTERVAL '5 minutes',
                      sh.start_time - ($5::float * INTERVAL '1 hour'), sh.start_time - ($5::float * INTERVAL '1 hour')
                 FROM shows sh WHERE sh.id = $2 RETURNING id`,
              [userId, showId, ref, total, hoursBefore],
              tx,
            );
            const bookingId = b!.id;
            const seatIds = chunk.map((x) => x.id);
            await execute(
              `INSERT INTO booking_seats (booking_id, show_seat_id, unit_price_minor)
               SELECT $1, id, price_minor FROM show_seats WHERE id = ANY($2::uuid[])`,
              [bookingId, seatIds],
              tx,
            );
            await execute(
              `UPDATE show_seats SET status = 'BOOKED', booking_id = $1 WHERE id = ANY($2::uuid[])`,
              [bookingId, seatIds],
              tx,
            );
            if (rand() < 0.08) {
              await execute(
                `INSERT INTO payments (booking_id, user_id, idempotency_key, request_hash, amount_minor, status, response_status, response_payload, created_at, updated_at)
                 SELECT $1, $2, $3, 'demo', $4, 'FAILED', 402, '{"status":"FAILED","code":"PAYMENT_DECLINED"}'::jsonb,
                        b.created_at - INTERVAL '1 minute', b.created_at - INTERVAL '1 minute' FROM bookings b WHERE b.id = $1`,
                [bookingId, userId, `demo-fail-${bookingId}`, total],
                tx,
              );
            }
            await execute(
              `INSERT INTO payments (booking_id, user_id, idempotency_key, request_hash, amount_minor, status, transaction_reference, response_status, response_payload, created_at, updated_at)
               SELECT $1, $2, $3, 'demo', $4, 'SUCCESS', $5, 201, '{"status":"SUCCESS"}'::jsonb, b.created_at, b.created_at FROM bookings b WHERE b.id = $1`,
              [bookingId, userId, `demo-ok-${bookingId}`, total, `MOCKTXN-DEMO-${randomBytes(3).toString('hex').toUpperCase()}`],
              tx,
            );
            await execute(
              `INSERT INTO tickets (booking_id, ticket_number, issued_at) SELECT $1, $2, b.created_at FROM bookings b WHERE b.id = $1`,
              [bookingId, `TKT-DEMO${randomBytes(5).toString('hex').toUpperCase()}`],
              tx,
            );
            bookingsCreated += 1;
          }

          // A few abandoned holds that expired, so status charts show realistic non-sales.
          for (const s of unsold.slice(0, 2)) {
            if (rand() < 0.5) continue;
            const userId = customers[Math.floor(rand() * customers.length)]!;
            await execute(
              `INSERT INTO bookings (user_id, show_id, booking_reference, total_amount_minor, status, hold_expires_at, created_at, updated_at)
               SELECT $1, $2, $3, $4, 'EXPIRED', sh.start_time - INTERVAL '3 hours', sh.start_time - INTERVAL '3 hours 5 minutes', sh.start_time - INTERVAL '3 hours'
                 FROM shows sh WHERE sh.id = $2`,
              [userId, showId, `DX${randomBytes(4).toString('hex').toUpperCase()}`, s.price],
              tx,
            );
          }
        });
      }
    }
  }
  return bookingsCreated;
}

async function seedLocalAccounts(password: string) {
  const hash = await bcrypt.hash(password, 10);
  const admin = await upsertUser('Demo Admin', 'admin@demo.local', 'ADMIN', 'ACTIVE', hash);
  await upsertUser('Demo Customer', 'customer@demo.local', 'CUSTOMER', 'ACTIVE', hash);
  const manager = await upsertUser('Demo Manager', 'manager@demo.local', 'THEATRE_MANAGER', 'ACTIVE', hash);
  await upsertUser('Pending Manager', 'pending.manager@demo.local', 'THEATRE_MANAGER', 'PENDING_APPROVAL', hash);
  const existing = await selectOne('SELECT 1 AS x FROM theatres WHERE name = $1', ['Harbour Lights (pending demo)']);
  if (!existing) {
    await execute(
      `INSERT INTO theatres (name, city, address, contact_number, approval_status, submitted_by)
       VALUES ('Harbour Lights (pending demo)', 'Chennai', '3 Beach Road, Chennai 600001', '+91 44 5550 0404', 'PENDING_APPROVAL', $1)`,
      [manager],
    );
  }
  await execute(
    `INSERT INTO theatre_manager_assignments (manager_id, theatre_id, assigned_by)
     SELECT $1, t.id, $2 FROM theatres t WHERE t.name IN ('Aurora Cinemas','Skyline Multiplex','Riverside Screens')
     ON CONFLICT (manager_id, theatre_id) DO NOTHING`,
    [manager, admin],
  );
}

async function main() {
  const e = env();
  const demoPassword = process.env.DEMO_PASSWORD;
  if (demoPassword && e.NODE_ENV === 'production') {
    throw new Error('DEMO_PASSWORD accounts are local-only and refused when NODE_ENV=production');
  }
  const owner = await upsertUser('Demo Catalog Owner', 'catalog.owner@demo.invalid', 'THEATRE_MANAGER', 'ACTIVE', await randomHash());
  const movies = await seedMovies();
  const screens = await seedTheatres(owner);
  const created = await seedUpcomingShows(screens, Object.values(movies));
  const history = await seedHistory(screens, Object.values(movies));
  if (demoPassword) await seedLocalAccounts(demoPassword);
  logger.info({ upcomingShowsCreated: created, historicalBookings: history, localAccounts: Boolean(demoPassword) }, 'seed complete');
}

main()
  .then(() => sequelize.close())
  .catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });
