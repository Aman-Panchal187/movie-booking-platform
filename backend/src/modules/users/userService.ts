import { execute, selectOne, selectRows, sequelize } from '../../shared/database/sequelize';
import { AppError, notFound } from '../../shared/errors/errors';
import { AuthUser } from '../../shared/middleware/auth';
import { Page, likePattern } from '../../shared/utils/http';
import { writeAudit } from '../audit/auditService';

export async function listUsers(page: Page, filter: { role?: string; status?: string; q?: string }) {
  const bind = [filter.role ?? null, filter.status ?? null, filter.q ? likePattern(filter.q) : null];
  const where = `($1::text IS NULL OR u.role = $1) AND ($2::text IS NULL OR u.account_status = $2)
                 AND ($3::text IS NULL OR u.name ILIKE $3 OR u.email ILIKE $3)`;
  const total = await selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, bind);
  // Explicit column list: password hashes are never selected.
  const rows = await selectRows(
    `SELECT u.id, u.name, u.email, u.role, u.account_status AS "accountStatus",
            u.rejection_reason AS "rejectionReason", u.created_at AS "createdAt"
       FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT $4 OFFSET $5`,
    [...bind, page.limit, page.offset],
  );
  return { rows, total: total?.n ?? 0 };
}

/** Suspend or reactivate customers/managers. Admin accounts cannot be changed through the API. */
export async function setAccountSuspended(admin: AuthUser, userId: string, suspend: boolean, reason?: string) {
  await sequelize.transaction(async (transaction) => {
    const u = await selectOne<{ role: string; status: string }>(
      'SELECT role, account_status AS status FROM users WHERE id = $1 FOR UPDATE',
      [userId],
      transaction,
    );
    if (!u) throw notFound('User');
    if (u.role === 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Administrator accounts cannot be suspended here');
    const next = suspend ? 'SUSPENDED' : 'ACTIVE';
    if (u.status === next) return;
    if (suspend && u.status === 'SUSPENDED') return;
    if (!suspend && u.status !== 'SUSPENDED') {
      throw new AppError(409, 'CONFLICT', 'Only suspended accounts can be reactivated');
    }
    await execute(
      `UPDATE users SET account_status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId, next, suspend ? (reason ?? null) : null, admin.id],
      transaction,
    );
    await writeAudit(
      { actorUserId: admin.id, entityType: 'USER', entityId: userId, action: suspend ? 'USER_SUSPEND' : 'USER_REACTIVATE', previousStatus: u.status, newStatus: next, reason },
      transaction,
    );
  });
}
