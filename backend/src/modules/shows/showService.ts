import { CacheService, TTL } from '../../shared/cache/cacheService';
import { execute, selectOne, selectRows, sequelize } from '../../shared/database/sequelize';
import { conflict, notFound } from '../../shared/errors/errors';
import { AuthUser } from '../../shared/middleware/auth';
import { assertTheatreAccess, operableTheatreIds } from '../theatres/theatreAccess';
import { Page } from '../../shared/utils/http';

/** Business timezone: show dates and report day boundaries are evaluated in IST. */
export const BUSINESS_TZ = 'Asia/Kolkata';
const TURNAROUND_MINUTES = 20;

export interface ShowFilter {
  movieId?: string;
  theatreId?: string;
  city?: string;
  date?: string;
}

export interface PriceTable {
  STANDARD: number;
  PREMIUM: number;
  RECLINER: number;
}

const AVAILABLE_EXPR = `(ss.status = 'AVAILABLE' OR (ss.status = 'HELD' AND ss.hold_expires_at <= NOW()))`;

export class ShowService {
  constructor(private readonly cache: CacheService) {}

  listPublic(filter: ShowFilter) {
    return this.cache.getOrSet('shows', `list:${JSON.stringify(filter)}`, TTL.shows, () =>
      selectRows(
        `SELECT sh.id, sh.start_time AS "startTime", sh.end_time AS "endTime",
                m.id AS "movieId", m.title AS "movieTitle",
                t.id AS "theatreId", t.name AS "theatreName", t.city,
                sc.id AS "screenId", sc.name AS "screenName",
                (SELECT MIN(ss.price_minor) FROM show_seats ss WHERE ss.show_id = sh.id)::bigint AS "minPriceMinor",
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id AND ${AVAILABLE_EXPR})::int AS "availableSeats",
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id)::int AS "totalSeats"
           FROM shows sh
           JOIN movies m ON m.id = sh.movie_id AND m.is_active
           JOIN screens sc ON sc.id = sh.screen_id AND sc.is_active
           JOIN theatres t ON t.id = sc.theatre_id AND t.approval_status = 'APPROVED'
          WHERE sh.status = 'SCHEDULED' AND sh.start_time > NOW()
            AND ($1::uuid IS NULL OR sh.movie_id = $1)
            AND ($2::uuid IS NULL OR t.id = $2)
            AND ($3::text IS NULL OR LOWER(t.city) = LOWER($3))
            AND ($4::date IS NULL OR (sh.start_time AT TIME ZONE '${BUSINESS_TZ}')::date = $4::date)
          ORDER BY sh.start_time
          LIMIT 300`,
        [filter.movieId ?? null, filter.theatreId ?? null, filter.city ?? null, filter.date ?? null],
      ),
    );
  }

  /** Authoritative seat map straight from PostgreSQL (never cached). Expired holds read as AVAILABLE. */
  async seatMap(showId: string) {
    const show = await selectOne(
      `SELECT sh.id, sh.start_time AS "startTime", sh.end_time AS "endTime", sh.status,
              m.id AS "movieId", m.title AS "movieTitle", m.poster_url AS "posterUrl",
              m.certification, m.language,
              t.id AS "theatreId", t.name AS "theatreName", t.city, sc.name AS "screenName"
         FROM shows sh
         JOIN movies m ON m.id = sh.movie_id
         JOIN screens sc ON sc.id = sh.screen_id
         JOIN theatres t ON t.id = sc.theatre_id AND t.approval_status = 'APPROVED'
        WHERE sh.id = $1`,
      [showId],
    );
    if (!show) throw notFound('Show');
    const seats = await selectRows(
      `SELECT ss.id AS "showSeatId", se.row_label AS "row", se.seat_number AS "number",
              se.seat_type AS "seatType", ss.price_minor AS "priceMinor",
              CASE WHEN ss.status = 'HELD' AND ss.hold_expires_at <= NOW() THEN 'AVAILABLE' ELSE ss.status END AS status
         FROM show_seats ss JOIN seats se ON se.id = ss.seat_id
        WHERE ss.show_id = $1
        ORDER BY se.row_label, se.seat_number`,
      [showId],
    );
    return { show, seats };
  }

  async create(
    manager: AuthUser,
    input: { movieId: string; screenId: string; startTime: string; prices: PriceTable },
  ) {
    const screen = await selectOne<{ theatreId: string; isActive: boolean }>(
      'SELECT theatre_id AS "theatreId", is_active AS "isActive" FROM screens WHERE id = $1',
      [input.screenId],
    );
    if (!screen) throw notFound('Screen');
    await assertTheatreAccess(manager, screen.theatreId, { requireApproved: true });
    if (!screen.isActive) throw conflict('Screen is not active');

    const movie = await selectOne<{ duration: number }>(
      'SELECT duration_minutes AS duration FROM movies WHERE id = $1 AND is_active',
      [input.movieId],
    );
    if (!movie) throw notFound('Movie');

    const showId = await sequelize.transaction(async (transaction) => {
      const rows = await execute<{ id: string }>(
        `INSERT INTO shows (movie_id, screen_id, start_time, end_time)
         SELECT $1, $2, $3::timestamptz, $3::timestamptz + ($4::int * INTERVAL '1 minute')
          WHERE $3::timestamptz > NOW()
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [input.movieId, input.screenId, input.startTime, movie.duration + TURNAROUND_MINUTES],
        transaction,
      );
      const id = rows[0]?.id;
      if (!id) throw conflict('Show must start in the future and may not overlap another show on this screen');
      await execute(
        `INSERT INTO show_seats (show_id, seat_id, price_minor)
         SELECT $1, se.id,
                CASE se.seat_type WHEN 'RECLINER' THEN $4::bigint WHEN 'PREMIUM' THEN $3::bigint ELSE $2::bigint END
           FROM seats se WHERE se.screen_id = $5`,
        [id, input.prices.STANDARD, input.prices.PREMIUM, input.prices.RECLINER, input.screenId],
        transaction,
      );
      return id;
    });
    await this.cache.invalidate('shows');
    return showId;
  }

  /** Cancelling is only allowed while nothing is held or sold, so no ticket is ever invalidated. */
  async cancel(manager: AuthUser, showId: string) {
    const show = await selectOne<{ theatreId: string }>(
      `SELECT sc.theatre_id AS "theatreId" FROM shows sh JOIN screens sc ON sc.id = sh.screen_id WHERE sh.id = $1`,
      [showId],
    );
    if (!show) throw notFound('Show');
    await assertTheatreAccess(manager, show.theatreId, { requireApproved: true });
    await sequelize.transaction(async (transaction) => {
      // Locking the seat rows serializes against in-flight holds and payments.
      await selectRows('SELECT id FROM show_seats WHERE show_id = $1 ORDER BY id FOR UPDATE', [showId], transaction);
      const blocking = await selectOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM show_seats
          WHERE show_id = $1 AND (status = 'BOOKED' OR (status = 'HELD' AND hold_expires_at > NOW()))`,
        [showId],
        transaction,
      );
      if (Number(blocking?.n) > 0) {
        throw conflict('This show has held or confirmed bookings and cannot be cancelled in this version');
      }
      await execute("UPDATE shows SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1", [showId], transaction);
    });
    await this.cache.invalidate('shows');
  }

  /** Manager/admin listing scoped to theatres the caller may operate. */
  async listManaged(user: AuthUser, theatreId: string | undefined, page: Page) {
    const allowed = await operableTheatreIds(user);
    if (theatreId) await assertTheatreAccess(user, theatreId);
    const scope = theatreId ? [theatreId] : allowed;
    const rows = await selectRows(
      `SELECT sh.id, sh.status, sh.start_time AS "startTime", sh.end_time AS "endTime",
              m.title AS "movieTitle", t.id AS "theatreId", t.name AS "theatreName", sc.name AS "screenName",
              COUNT(ss.id)::int AS "totalSeats",
              COUNT(ss.id) FILTER (WHERE ss.status = 'BOOKED')::int AS "bookedSeats",
              COALESCE(SUM(ss.price_minor) FILTER (WHERE ss.status = 'BOOKED'), 0)::bigint AS "revenueMinor"
         FROM shows sh
         JOIN movies m ON m.id = sh.movie_id
         JOIN screens sc ON sc.id = sh.screen_id
         JOIN theatres t ON t.id = sc.theatre_id
         LEFT JOIN show_seats ss ON ss.show_id = sh.id
        WHERE t.id = ANY($1::uuid[])
        GROUP BY sh.id, m.title, t.id, sc.name
        ORDER BY sh.start_time DESC LIMIT $2 OFFSET $3`,
      [scope, page.limit, page.offset],
    );
    const total = await selectOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM shows sh JOIN screens sc ON sc.id = sh.screen_id WHERE sc.theatre_id = ANY($1::uuid[])`,
      [scope],
    );
    return { rows, total: Number(total?.n ?? 0) };
  }
}
