import { execute, selectOne, selectRows, sequelize } from '../../shared/database/sequelize';
import { AppError, notFound } from '../../shared/errors/errors';
import { AuthUser } from '../../shared/middleware/auth';
import { Page, likePattern } from '../../shared/utils/http';
import { writeAudit } from '../audit/auditService';

export type ManagerDecision = 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REACTIVATE';

const TARGET: Record<ManagerDecision, string> = {
  APPROVE: 'ACTIVE',
  REJECT: 'REJECTED',
  SUSPEND: 'SUSPENDED',
  REACTIVATE: 'ACTIVE',
};

/** Which current statuses each decision may start from. */
const ALLOWED_FROM: Record<ManagerDecision, string[]> = {
  APPROVE: ['PENDING_APPROVAL', 'REJECTED'],
  REJECT: ['PENDING_APPROVAL'],
  SUSPEND: ['ACTIVE'],
  REACTIVATE: ['SUSPENDED'],
};

const SAFE_USER_COLS = `u.id, u.name, u.email, u.role, u.account_status AS "accountStatus",
  u.rejection_reason AS "rejectionReason", u.created_at AS "createdAt", u.reviewed_at AS "reviewedAt"`;

export async function listManagerRequests(page: Page, status?: string, q?: string) {
  const bind = [status ?? null, q ? likePattern(q) : null];
  const where = `u.role = 'THEATRE_MANAGER' AND ($1::text IS NULL OR u.account_status = $1)
                 AND ($2::text IS NULL OR u.name ILIKE $2 OR u.email ILIKE $2)`;
  const total = await selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, bind);
  const rows = await selectRows(
    `SELECT ${SAFE_USER_COLS},
            (SELECT COUNT(*)::int FROM theatre_manager_assignments a WHERE a.manager_id = u.id) AS "theatreCount"
       FROM users u WHERE ${where}
      ORDER BY (u.account_status = 'PENDING_APPROVAL') DESC, u.created_at DESC LIMIT $3 OFFSET $4`,
    [...bind, page.limit, page.offset],
  );
  return { rows, total: total?.n ?? 0 };
}

/**
 * Applies an admin decision. Row-locked and idempotent: repeating a decision that is already in effect
 * returns the current state; a decision that conflicts with the current state is a 409.
 */
export async function decideManager(
  admin: AuthUser,
  managerId: string,
  decision: ManagerDecision,
  reason?: string,
) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const target = await selectOne<{ id: string; role: string; status: string }>(
      'SELECT id, role, account_status AS status FROM users WHERE id = $1 FOR UPDATE',
      [managerId],
      transaction,
    );
    if (!target || target.role !== 'THEATRE_MANAGER') throw notFound('Manager');
    const next = TARGET[decision];
    if (target.status === next) return { changed: false };
    if (!ALLOWED_FROM[decision].includes(target.status)) {
      throw new AppError(409, 'CONFLICT', `Cannot ${decision.toLowerCase()} a manager whose status is ${target.status}`);
    }
    await execute(
      `UPDATE users SET account_status = $2, rejection_reason = $3, reviewed_by = $4,
              reviewed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [managerId, next, decision === 'REJECT' || decision === 'SUSPEND' ? (reason ?? null) : null, admin.id],
      transaction,
    );
    await writeAudit(
      { actorUserId: admin.id, entityType: 'USER', entityId: managerId, action: `MANAGER_${decision}`, previousStatus: target.status, newStatus: next, reason },
      transaction,
    );
    return { changed: true };
  });
  const manager = await selectOne(`SELECT ${SAFE_USER_COLS} FROM users u WHERE u.id = $1`, [managerId]);
  return { ...outcome, manager };
}

/** Status payload for the manager's own "pending approval" page. */
export async function managerAccountStatus(manager: AuthUser) {
  const counts = await selectOne<{ approved: number; pending: number; rejected: number }>(
    `SELECT COUNT(*) FILTER (WHERE approval_status = 'APPROVED')::int AS approved,
            COUNT(*) FILTER (WHERE approval_status = 'PENDING_APPROVAL')::int AS pending,
            COUNT(*) FILTER (WHERE approval_status = 'REJECTED')::int AS rejected
       FROM theatres WHERE submitted_by = $1`,
    [manager.id],
  );
  return {
    accountStatus: manager.accountStatus,
    rejectionReason: manager.rejectionReason,
    theatres: counts,
  };
}
