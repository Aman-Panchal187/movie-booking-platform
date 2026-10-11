import { Transaction } from 'sequelize';
import { execute, selectOne, selectRows } from '../../shared/database/sequelize';
import { Page, likePattern } from '../../shared/utils/http';

export interface AuditEntry {
  actorUserId: string;
  entityType: 'USER' | 'THEATRE' | 'THEATRE_ASSIGNMENT' | 'MOVIE';
  entityId: string;
  action: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  reason?: string | null;
}

/** Writes an audit row inside the caller's transaction so decision and audit commit together. */
export async function writeAudit(entry: AuditEntry, transaction: Transaction): Promise<void> {
  await execute(
    `INSERT INTO approval_audit_logs
       (actor_user_id, entity_type, entity_id, action, previous_status, new_status, rejection_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorUserId,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.previousStatus ?? null,
      entry.newStatus ?? null,
      entry.reason ?? null,
    ],
    transaction,
  );
}

export async function listAudit(page: Page, filter: { entityType?: string; q?: string }) {
  const where = ['($1::text IS NULL OR l.entity_type = $1)', '($2::text IS NULL OR u.email ILIKE $2 OR l.action ILIKE $2)'];
  const bind = [filter.entityType ?? null, filter.q ? likePattern(filter.q) : null];
  const total = await selectOne<{ count: string }>(
    `SELECT COUNT(*) FROM approval_audit_logs l JOIN users u ON u.id = l.actor_user_id WHERE ${where.join(' AND ')}`,
    bind,
  );
  const rows = await selectRows(
    `SELECT l.id, l.entity_type AS "entityType", l.entity_id AS "entityId", l.action,
            l.previous_status AS "previousStatus", l.new_status AS "newStatus",
            l.rejection_reason AS "reason", l.created_at AS "createdAt",
            u.name AS "actorName", u.email AS "actorEmail"
       FROM approval_audit_logs l JOIN users u ON u.id = l.actor_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`,
    [...bind, page.limit, page.offset],
  );
  return { rows, total: Number(total?.count ?? 0) };
}
