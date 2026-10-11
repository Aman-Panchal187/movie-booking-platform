import { selectOne, selectRows } from '../../shared/database/sequelize';
import { Page, likePattern } from '../../shared/utils/http';

/** Platform-wide read-only listings for the admin console. No credential or secret columns are selected. */
export async function listAllBookings(page: Page, filter: { status?: string; q?: string }) {
  const bind = [filter.status ?? null, filter.q ? likePattern(filter.q) : null];
  const where = `($1::text IS NULL OR b.status = $1)
                 AND ($2::text IS NULL OR b.booking_reference ILIKE $2 OR u.email ILIKE $2 OR m.title ILIKE $2)`;
  const from = `FROM bookings b JOIN users u ON u.id = b.user_id JOIN shows sh ON sh.id = b.show_id
                JOIN movies m ON m.id = sh.movie_id JOIN screens sc ON sc.id = sh.screen_id
                JOIN theatres t ON t.id = sc.theatre_id`;
  const total = await selectOne<{ n: number }>(`SELECT COUNT(*) AS n ${from} WHERE ${where}`, bind);
  const rows = await selectRows(
    `SELECT b.id, b.booking_reference AS reference,
            CASE WHEN b.status = 'HELD' AND b.hold_expires_at <= NOW() THEN 'EXPIRED' ELSE b.status END AS status,
            b.total_amount_minor AS "totalAmountMinor", b.created_at AS "createdAt",
            u.name AS "customerName", u.email AS "customerEmail",
            m.title AS "movieTitle", t.name AS "theatreName", sh.start_time AS "startTime"
       ${from} WHERE ${where} ORDER BY b.created_at DESC LIMIT $3 OFFSET $4`,
    [...bind, page.limit, page.offset],
  );
  return { rows, total: total?.n ?? 0 };
}

export async function listAllPayments(page: Page, filter: { status?: string }) {
  const bind = [filter.status ?? null];
  const total = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM payments p WHERE ($1::text IS NULL OR p.status = $1)', bind);
  const rows = await selectRows(
    `SELECT p.id, p.status, p.amount_minor AS "amountMinor", p.currency,
            p.transaction_reference AS "transactionReference", p.created_at AS "createdAt",
            b.booking_reference AS "bookingReference", u.email AS "customerEmail"
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN users u ON u.id = p.user_id
      WHERE ($1::text IS NULL OR p.status = $1)
      ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
    [...bind, page.limit, page.offset],
  );
  return { rows, total: total?.n ?? 0 };
}
