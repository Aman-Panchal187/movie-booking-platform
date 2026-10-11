import { Transaction } from 'sequelize';
import { selectOne, selectRows } from '../../shared/database/sequelize';
import { forbidden, notFound } from '../../shared/errors/errors';
import { AuthUser } from '../../shared/middleware/auth';

export type TheatreStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

/**
 * Verifies against the database, on every call, that the manager is assigned to the theatre
 * (and optionally that it is APPROVED). Admins pass for any existing theatre.
 */
export async function assertTheatreAccess(
  user: AuthUser,
  theatreId: string,
  opts: { requireApproved?: boolean; transaction?: Transaction } = {},
): Promise<{ id: string; approvalStatus: TheatreStatus }> {
  const theatre = await selectOne<{ id: string; approvalStatus: TheatreStatus }>(
    'SELECT id, approval_status AS "approvalStatus" FROM theatres WHERE id = $1',
    [theatreId],
    opts.transaction,
  );
  if (!theatre) throw notFound('Theatre');
  if (user.role !== 'ADMIN') {
    const assigned = await selectOne(
      'SELECT 1 AS ok FROM theatre_manager_assignments WHERE manager_id = $1 AND theatre_id = $2',
      [user.id, theatreId],
      opts.transaction,
    );
    if (!assigned) throw forbidden('You are not assigned to this theatre');
  }
  if (opts.requireApproved && theatre.approvalStatus !== 'APPROVED') {
    throw forbidden('This theatre is not approved for operation');
  }
  return theatre;
}

/** IDs of approved theatres a manager may operate (all approved theatres for admins). */
export async function operableTheatreIds(user: AuthUser): Promise<string[]> {
  const rows =
    user.role === 'ADMIN'
      ? await selectRows<{ id: string }>("SELECT id FROM theatres WHERE approval_status = 'APPROVED'")
      : await selectRows<{ id: string }>(
          `SELECT t.id FROM theatres t
             JOIN theatre_manager_assignments a ON a.theatre_id = t.id
            WHERE a.manager_id = $1 AND t.approval_status = 'APPROVED'`,
          [user.id],
        );
  return rows.map((r) => r.id);
}
