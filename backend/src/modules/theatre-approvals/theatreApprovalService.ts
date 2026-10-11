import { CacheService } from '../../shared/cache/cacheService';
import { execute, selectOne, selectRows, sequelize } from '../../shared/database/sequelize';
import { AppError, conflict, notFound } from '../../shared/errors/errors';
import { AuthUser } from '../../shared/middleware/auth';
import { Page, likePattern } from '../../shared/utils/http';
import { writeAudit } from '../audit/auditService';

export type TheatreDecision = 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REINSTATE';

const TARGET: Record<TheatreDecision, string> = {
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  SUSPEND: 'SUSPENDED',
  REINSTATE: 'APPROVED',
};

const ALLOWED_FROM: Record<TheatreDecision, string[]> = {
  APPROVE: ['PENDING_APPROVAL'],
  REJECT: ['PENDING_APPROVAL'],
  SUSPEND: ['APPROVED'],
  REINSTATE: ['SUSPENDED'],
};

const THEATRE_ADMIN_COLS = `t.id, t.name, t.city, t.address, t.contact_number AS "contactNumber", t.description,
  t.approval_status AS "approvalStatus", t.rejection_reason AS "rejectionReason", t.created_at AS "createdAt",
  t.reviewed_at AS "reviewedAt", u.id AS "submittedById", u.name AS "submittedByName", u.email AS "submittedByEmail"`;

export class TheatreApprovalService {
  constructor(private readonly cache: CacheService) {}

  async list(page: Page, status?: string, q?: string) {
    const bind = [status ?? null, q ? likePattern(q) : null];
    const where = `($1::text IS NULL OR t.approval_status = $1) AND ($2::text IS NULL OR t.name ILIKE $2 OR t.city ILIKE $2)`;
    const total = await selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM theatres t WHERE ${where}`, bind);
    const rows = await selectRows(
      `SELECT ${THEATRE_ADMIN_COLS},
              (SELECT COALESCE(json_agg(json_build_object('managerId', m.id, 'name', m.name, 'email', m.email)), '[]'::json)
                 FROM theatre_manager_assignments a JOIN users m ON m.id = a.manager_id
                WHERE a.theatre_id = t.id) AS managers
         FROM theatres t JOIN users u ON u.id = t.submitted_by
        WHERE ${where}
        ORDER BY (t.approval_status = 'PENDING_APPROVAL') DESC, t.created_at DESC LIMIT $3 OFFSET $4`,
      [...bind, page.limit, page.offset],
    );
    return { rows, total: total?.n ?? 0 };
  }

  /** Transactional, row-locked and idempotent decision on a single theatre. */
  async decide(admin: AuthUser, theatreId: string, decision: TheatreDecision, reason?: string) {
    const result = await sequelize.transaction(async (transaction) => {
      const t = await selectOne<{ status: string; submittedBy: string; managerStatus: string }>(
        `SELECT t.approval_status AS status, t.submitted_by AS "submittedBy", u.account_status AS "managerStatus"
           FROM theatres t JOIN users u ON u.id = t.submitted_by
          WHERE t.id = $1 FOR UPDATE OF t`,
        [theatreId],
        transaction,
      );
      if (!t) throw notFound('Theatre');
      const next = TARGET[decision];
      if (t.status === next) return { changed: false };
      if (!ALLOWED_FROM[decision].includes(t.status)) {
        throw new AppError(409, 'CONFLICT', `Cannot ${decision.toLowerCase()} a theatre whose status is ${t.status}`);
      }
      if (decision === 'APPROVE' && t.managerStatus !== 'ACTIVE') {
        throw conflict('The submitting manager account is not active');
      }
      await execute(
        `UPDATE theatres SET approval_status = $2, rejection_reason = $3, reviewed_by = $4,
                reviewed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [theatreId, next, decision === 'REJECT' || decision === 'SUSPEND' ? (reason ?? null) : null, admin.id],
        transaction,
      );
      if (decision === 'APPROVE') {
        await execute(
          `INSERT INTO theatre_manager_assignments (manager_id, theatre_id, assigned_by)
           VALUES ($1, $2, $3) ON CONFLICT (manager_id, theatre_id) DO NOTHING`,
          [t.submittedBy, theatreId, admin.id],
          transaction,
        );
        await writeAudit(
          { actorUserId: admin.id, entityType: 'THEATRE_ASSIGNMENT', entityId: theatreId, action: 'MANAGER_ASSIGNED', newStatus: 'ASSIGNED' },
          transaction,
        );
      }
      await writeAudit(
        { actorUserId: admin.id, entityType: 'THEATRE', entityId: theatreId, action: `THEATRE_${decision}`, previousStatus: t.status, newStatus: next, reason },
        transaction,
      );
      return { changed: true };
    });
    await this.cache.invalidate('theatres', 'shows', 'movies');
    const theatre = await selectOne(
      `SELECT ${THEATRE_ADMIN_COLS} FROM theatres t JOIN users u ON u.id = t.submitted_by WHERE t.id = $1`,
      [theatreId],
    );
    return { ...result, theatre };
  }

  async assignManager(admin: AuthUser, theatreId: string, managerId: string) {
    await sequelize.transaction(async (transaction) => {
      const theatre = await selectOne('SELECT id FROM theatres WHERE id = $1 FOR UPDATE', [theatreId], transaction);
      if (!theatre) throw notFound('Theatre');
      const manager = await selectOne<{ status: string }>(
        "SELECT account_status AS status FROM users WHERE id = $1 AND role = 'THEATRE_MANAGER'",
        [managerId],
        transaction,
      );
      if (!manager) throw notFound('Manager');
      if (manager.status !== 'ACTIVE') throw conflict('Only approved (active) managers can be assigned');
      const inserted = await execute(
        `INSERT INTO theatre_manager_assignments (manager_id, theatre_id, assigned_by)
         VALUES ($1, $2, $3) ON CONFLICT (manager_id, theatre_id) DO NOTHING RETURNING id`,
        [managerId, theatreId, admin.id],
        transaction,
      );
      if (inserted.length > 0) {
        await writeAudit(
          { actorUserId: admin.id, entityType: 'THEATRE_ASSIGNMENT', entityId: theatreId, action: 'MANAGER_ASSIGNED', newStatus: managerId },
          transaction,
        );
      }
    });
  }

  /** Revokes access without deleting the theatre or any of its data. */
  async revokeManager(admin: AuthUser, theatreId: string, managerId: string) {
    await sequelize.transaction(async (transaction) => {
      const removed = await execute(
        'DELETE FROM theatre_manager_assignments WHERE theatre_id = $1 AND manager_id = $2 RETURNING id',
        [theatreId, managerId],
        transaction,
      );
      if (removed.length === 0) throw notFound('Assignment');
      await writeAudit(
        { actorUserId: admin.id, entityType: 'THEATRE_ASSIGNMENT', entityId: theatreId, action: 'MANAGER_REVOKED', previousStatus: managerId, newStatus: 'REVOKED' },
        transaction,
      );
    });
  }

  /** Requests the signed-in manager submitted, with their review outcome. */
  listForManager(manager: AuthUser) {
    return selectRows(
      `SELECT t.id, t.name, t.city, t.approval_status AS "approvalStatus",
              t.rejection_reason AS "rejectionReason", t.created_at AS "createdAt", t.reviewed_at AS "reviewedAt"
         FROM theatres t WHERE t.submitted_by = $1 ORDER BY t.created_at DESC`,
      [manager.id],
    );
  }
}
