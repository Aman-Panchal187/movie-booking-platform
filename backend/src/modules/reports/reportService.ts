import { CacheService, TTL } from '../../shared/cache/cacheService';
import { selectOne, selectRows } from '../../shared/database/sequelize';
import { AppError } from '../../shared/errors/errors';
import { Page } from '../../shared/utils/http';
import { BUSINESS_TZ } from '../shows/showService';

/*
 * Reporting rules (all computed in SQL, never from frontend data):
 *  - A "sale" is a CONFIRMED booking that has a SUCCESS payment. Failed/expired/held bookings never count.
 *  - Revenue is the SUCCESS payment amount; tickets are counted per booking with a correlated
 *    subquery so booking_seats can never multiply payment amounts.
 *  - Days are business days in Asia/Kolkata; the range is [from 00:00, to+1day 00:00) in that zone.
 */

export interface ReportQuery {
  range: 'today' | '7d' | '30d' | 'custom';
  from?: string;
  to?: string;
}

export interface ReportScope {
  /** null = whole platform (admin). Otherwise the exact theatres the caller may see. */
  theatreIds: string[] | null;
}

interface Window {
  from: string;
  to: string;
}

function istDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
}

export function resolveWindow(q: ReportQuery): Window {
  switch (q.range) {
    case 'today':
      return { from: istDate(), to: istDate() };
    case '7d':
      return { from: istDate(-6), to: istDate() };
    case '30d':
      return { from: istDate(-29), to: istDate() };
    case 'custom': {
      if (!q.from || !q.to) throw new AppError(422, 'VALIDATION_ERROR', 'Custom range needs from and to dates');
      if (q.from > q.to) throw new AppError(422, 'VALIDATION_ERROR', 'from must not be after to');
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      if (days > 366) throw new AppError(422, 'VALIDATION_ERROR', 'Custom range is limited to 366 days');
      return { from: q.from, to: q.to };
    }
  }
}

const TZ = `'${BUSINESS_TZ}'`;
// $1 = from date, $2 = to date (inclusive), $3 = theatre ids or NULL
const PAID_WINDOW = `p.created_at >= ($1::date)::timestamp AT TIME ZONE ${TZ}
                AND p.created_at < (($2::date) + 1)::timestamp AT TIME ZONE ${TZ}`;
const SHOW_WINDOW = `sh.start_time >= ($1::date)::timestamp AT TIME ZONE ${TZ}
                AND sh.start_time < (($2::date) + 1)::timestamp AT TIME ZONE ${TZ}`;
const SCOPE = '($3::uuid[] IS NULL OR t.id = ANY($3::uuid[]))';

/** One row per sale; seats are a scalar subquery, so no join can duplicate revenue. */
const SALES_CTE = `
  WITH sales AS (
    SELECT b.id AS booking_id, b.booking_reference, p.amount_minor, p.created_at AS paid_at,
           sh.id AS show_id, sh.start_time, m.id AS movie_id, m.title AS movie_title,
           t.id AS theatre_id, t.name AS theatre_name, u.name AS customer_name,
           (SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = b.id) AS seats
      FROM payments p
      JOIN bookings b ON b.id = p.booking_id AND b.status = 'CONFIRMED'
      JOIN users u ON u.id = b.user_id
      JOIN shows sh ON sh.id = b.show_id
      JOIN movies m ON m.id = sh.movie_id
      JOIN screens sc ON sc.id = sh.screen_id
      JOIN theatres t ON t.id = sc.theatre_id
     WHERE p.status = 'SUCCESS' AND ${PAID_WINDOW} AND ${SCOPE}
  )`;

export class ReportService {
  constructor(private readonly cache: CacheService) {}

  private cached<T>(name: string, scope: ReportScope, w: Window, extra: unknown, loader: () => Promise<T>) {
    const key = `${name}:${JSON.stringify([scope.theatreIds, w, extra])}`;
    return this.cache.getOrSet('reports', key, TTL.reports, loader);
  }

  private bind(scope: ReportScope, w: Window) {
    return [w.from, w.to, scope.theatreIds];
  }

  async summary(scope: ReportScope, q: ReportQuery) {
    const w = resolveWindow(q);
    return this.cached('summary', scope, w, null, async () => {
      const sales = await selectOne<{ bookings: number; tickets: number; revenueMinor: number }>(
        `${SALES_CTE}
         SELECT COUNT(*)::int AS bookings, COALESCE(SUM(seats), 0)::int AS tickets,
                COALESCE(SUM(amount_minor), 0)::bigint AS "revenueMinor" FROM sales`,
        this.bind(scope, w),
      );
      const occupancy = await selectOne<{ avgOccupancyPct: number | null; showsInRange: number }>(
        `SELECT ROUND(AVG(x.booked * 100.0 / NULLIF(x.total, 0)), 1) AS "avgOccupancyPct", COUNT(*)::int AS "showsInRange"
           FROM (SELECT sh.id,
                        COUNT(ss.id) FILTER (WHERE ss.status = 'BOOKED') AS booked, COUNT(ss.id) AS total
                   FROM shows sh
                   JOIN screens sc ON sc.id = sh.screen_id
                   JOIN theatres t ON t.id = sc.theatre_id
                   JOIN show_seats ss ON ss.show_id = sh.id
                  WHERE sh.status = 'SCHEDULED' AND ${SHOW_WINDOW} AND ${SCOPE}
                  GROUP BY sh.id) x`,
        this.bind(scope, w),
      );
      const upcoming = await selectOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM shows sh
           JOIN screens sc ON sc.id = sh.screen_id JOIN theatres t ON t.id = sc.theatre_id
          WHERE sh.status = 'SCHEDULED' AND sh.end_time > NOW() AND ${SCOPE.replaceAll('$3', '$1')}`,
        [scope.theatreIds],
      );
      return { window: w, ...sales, avgOccupancyPct: occupancy?.avgOccupancyPct ?? 0, showsInRange: occupancy?.showsInRange ?? 0, activeShows: upcoming?.n ?? 0 };
    });
  }

  /** Daily series with zero-filled days: revenue + bookings + tickets. */
  async revenueSeries(scope: ReportScope, q: ReportQuery) {
    const w = resolveWindow(q);
    return this.cached('series', scope, w, null, async () => ({
      window: w,
      series: await selectRows(
        `${SALES_CTE}
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                COUNT(s.booking_id)::int AS bookings,
                COALESCE(SUM(s.seats), 0)::int AS tickets,
                COALESCE(SUM(s.amount_minor), 0)::bigint AS "revenueMinor"
           FROM generate_series($1::date::timestamp, $2::date::timestamp, INTERVAL '1 day') AS d(day)
           LEFT JOIN sales s ON (s.paid_at AT TIME ZONE ${TZ})::date = d.day::date
          GROUP BY d.day ORDER BY d.day`,
        this.bind(scope, w),
      ),
    }));
  }

  async bookings(scope: ReportScope, q: ReportQuery, page: Page) {
    const w = resolveWindow(q);
    return this.cached('bookings', scope, w, page, async () => {
      const bind = this.bind(scope, w);
      const byMovie = await selectRows(
        `${SALES_CTE}
         SELECT movie_id AS "movieId", movie_title AS "movieTitle", COUNT(*)::int AS bookings,
                SUM(seats)::int AS tickets, SUM(amount_minor)::bigint AS "revenueMinor"
           FROM sales GROUP BY movie_id, movie_title ORDER BY SUM(amount_minor) DESC LIMIT 10`,
        bind,
      );
      const total = await selectOne<{ n: number }>(`${SALES_CTE} SELECT COUNT(*)::int AS n FROM sales`, bind);
      const rows = await selectRows(
        `${SALES_CTE}
         SELECT booking_id AS "bookingId", booking_reference AS reference, movie_title AS "movieTitle",
                theatre_name AS "theatreName", customer_name AS "customerName", seats::int AS tickets,
                amount_minor AS "amountMinor", paid_at AS "paidAt"
           FROM sales ORDER BY paid_at DESC LIMIT $4 OFFSET $5`,
        [...bind, page.limit, page.offset],
      );
      return { window: w, byMovie, rows, total: total?.n ?? 0 };
    });
  }

  async occupancy(scope: ReportScope, q: ReportQuery) {
    const w = resolveWindow(q);
    return this.cached('occupancy', scope, w, null, async () => ({
      window: w,
      shows: await selectRows(
        `SELECT sh.id AS "showId", m.title AS "movieTitle", t.name AS "theatreName", sc.name AS "screenName",
                sh.start_time AS "startTime",
                COUNT(ss.id)::int AS "totalSeats",
                COUNT(ss.id) FILTER (WHERE ss.status = 'BOOKED')::int AS "bookedSeats",
                ROUND(COUNT(ss.id) FILTER (WHERE ss.status = 'BOOKED') * 100.0 / NULLIF(COUNT(ss.id), 0), 1) AS "occupancyPct"
           FROM shows sh
           JOIN movies m ON m.id = sh.movie_id
           JOIN screens sc ON sc.id = sh.screen_id
           JOIN theatres t ON t.id = sc.theatre_id
           JOIN show_seats ss ON ss.show_id = sh.id
          WHERE sh.status = 'SCHEDULED' AND ${SHOW_WINDOW} AND ${SCOPE}
          GROUP BY sh.id, m.title, t.name, sc.name
          ORDER BY sh.start_time DESC LIMIT 40`,
        this.bind(scope, w),
      ),
    }));
  }

  /** Admin-only platform KPIs that are independent of the date window. */
  async platformTotals() {
    return selectOne<object>(
      `SELECT (SELECT COUNT(*)::int FROM users WHERE role = 'CUSTOMER') AS customers,
              (SELECT COUNT(*)::int FROM users WHERE role = 'THEATRE_MANAGER') AS managers,
              (SELECT COUNT(*)::int FROM theatres WHERE approval_status = 'APPROVED') AS "approvedTheatres",
              (SELECT COUNT(*)::int FROM users WHERE role = 'THEATRE_MANAGER' AND account_status = 'PENDING_APPROVAL') AS "pendingManagers",
              (SELECT COUNT(*)::int FROM theatres WHERE approval_status = 'PENDING_APPROVAL') AS "pendingTheatres"`,
    );
  }

  async theatreBreakdown(q: ReportQuery) {
    const w = resolveWindow(q);
    const scope: ReportScope = { theatreIds: null };
    return this.cached('theatres', scope, w, null, async () => {
      const bind = this.bind(scope, w);
      const theatres = await selectRows(
        `${SALES_CTE}
         SELECT t.id AS "theatreId", t.name AS "theatreName", t.city,
                COALESCE(r.bookings, 0)::int AS bookings, COALESCE(r.tickets, 0)::int AS tickets,
                COALESCE(r.revenue, 0)::bigint AS "revenueMinor",
                COALESCE(o.pct, 0) AS "occupancyPct"
           FROM theatres t
           LEFT JOIN (SELECT theatre_id, COUNT(*) AS bookings, SUM(seats) AS tickets, SUM(amount_minor) AS revenue
                        FROM sales GROUP BY theatre_id) r ON r.theatre_id = t.id
           LEFT JOIN (SELECT sc.theatre_id,
                             ROUND(AVG(x.booked * 100.0 / NULLIF(x.total, 0)), 1) AS pct
                        FROM (SELECT sh.id, sh.screen_id,
                                     COUNT(ss.id) FILTER (WHERE ss.status = 'BOOKED') AS booked, COUNT(ss.id) AS total
                                FROM shows sh JOIN show_seats ss ON ss.show_id = sh.id
                               WHERE sh.status = 'SCHEDULED' AND ${SHOW_WINDOW}
                               GROUP BY sh.id) x
                        JOIN screens sc ON sc.id = x.screen_id GROUP BY sc.theatre_id) o ON o.theatre_id = t.id
          WHERE t.approval_status = 'APPROVED'
          ORDER BY COALESCE(r.revenue, 0) DESC LIMIT 15`,
        bind,
      );
      const statusDistribution = await selectRows(
        `SELECT CASE WHEN b.status = 'HELD' AND b.hold_expires_at <= NOW() THEN 'EXPIRED' ELSE b.status END AS status,
                COUNT(*)::int AS count
           FROM bookings b
          WHERE b.created_at >= ($1::date)::timestamp AT TIME ZONE ${TZ}
            AND b.created_at < (($2::date) + 1)::timestamp AT TIME ZONE ${TZ}
          GROUP BY 1 ORDER BY 2 DESC`,
        [w.from, w.to],
      );
      const paymentDistribution = await selectRows(
        `SELECT p.status, COUNT(*)::int AS count FROM payments p
          WHERE ${PAID_WINDOW} GROUP BY p.status ORDER BY 2 DESC`,
        [w.from, w.to],
      );
      return { window: w, theatres, statusDistribution, paymentDistribution };
    });
  }
}
