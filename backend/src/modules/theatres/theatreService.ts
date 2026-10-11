import { CacheService, TTL } from '../../shared/cache/cacheService';
import { execute, selectOne, selectRows, sequelize } from '../../shared/database/sequelize';
import { AuthUser } from '../../shared/middleware/auth';
import { conflict, notFound } from '../../shared/errors/errors';
import { writeAudit } from '../audit/auditService';
import { assertTheatreAccess } from './theatreAccess';

const THEATRE_COLS = `t.id, t.name, t.city, t.address, t.contact_number AS "contactNumber",
  t.description, t.approval_status AS "approvalStatus", t.rejection_reason AS "rejectionReason",
  t.created_at AS "createdAt"`;

export interface TheatreInput {
  name: string;
  city: string;
  address: string;
  contactNumber: string;
  description?: string | null;
}

export class TheatreService {
  constructor(private readonly cache: CacheService) {}

  listPublic(city?: string) {
    return this.cache.getOrSet('theatres', `list:${city ?? ''}`, TTL.theatreList, () =>
      selectRows(
        `SELECT ${THEATRE_COLS},
                (SELECT COUNT(*)::int FROM screens s WHERE s.theatre_id = t.id AND s.is_active) AS "screenCount"
           FROM theatres t
          WHERE t.approval_status = 'APPROVED' AND ($1::text IS NULL OR LOWER(t.city) = LOWER($1))
          ORDER BY t.city, t.name`,
        [city ?? null],
      ),
    );
  }

  async getPublic(id: string) {
    const theatre = await this.cache.getOrSet('theatres', `detail:${id}`, TTL.theatreList, () =>
      selectOne(`SELECT ${THEATRE_COLS} FROM theatres t WHERE t.id = $1 AND t.approval_status = 'APPROVED'`, [id]),
    );
    if (!theatre) throw notFound('Theatre');
    return theatre;
  }

  /** Screens of a public theatre; pending/rejected/suspended theatres are invisible. */
  async listScreensPublic(theatreId: string) {
    await this.getPublic(theatreId);
    return this.listScreens(theatreId);
  }

  listScreens(theatreId: string) {
    return selectRows(
      `SELECT sc.id, sc.name, sc.is_active AS "isActive",
              COUNT(se.id)::int AS "seatCount",
              COALESCE(MAX(se.row_label), '') AS "lastRow"
         FROM screens sc LEFT JOIN seats se ON se.screen_id = sc.id
        WHERE sc.theatre_id = $1
        GROUP BY sc.id ORDER BY sc.name`,
      [theatreId],
    );
  }

  /** New theatres always start PENDING_APPROVAL; no assignment exists until an admin approves. */
  async submit(manager: AuthUser, input: TheatreInput) {
    return sequelize.transaction(async (transaction) => {
      const [row] = await execute<{ id: string }>(
        `INSERT INTO theatres (name, city, address, contact_number, description, approval_status, submitted_by)
         VALUES ($1,$2,$3,$4,$5,'PENDING_APPROVAL',$6) RETURNING id`,
        [input.name, input.city, input.address, input.contactNumber, input.description ?? null, manager.id],
        transaction,
      );
      await writeAudit(
        { actorUserId: manager.id, entityType: 'THEATRE', entityId: row!.id, action: 'SUBMITTED', newStatus: 'PENDING_APPROVAL' },
        transaction,
      );
      return row!.id;
    });
  }

  /** Theatres the manager submitted or is assigned to (any status), with their own status. */
  listForManager(manager: AuthUser) {
    return selectRows(
      `SELECT ${THEATRE_COLS},
              EXISTS (SELECT 1 FROM theatre_manager_assignments a WHERE a.theatre_id = t.id AND a.manager_id = $1) AS "assigned"
         FROM theatres t
        WHERE t.submitted_by = $1
           OR t.id IN (SELECT theatre_id FROM theatre_manager_assignments WHERE manager_id = $1)
        ORDER BY t.created_at DESC`,
      [manager.id],
    );
  }

  async getForManager(manager: AuthUser, id: string) {
    const theatre = await selectOne<{ id: string; submittedBy: string }>(
      'SELECT id, submitted_by AS "submittedBy" FROM theatres WHERE id = $1',
      [id],
    );
    if (!theatre) throw notFound('Theatre');
    const own = theatre.submittedBy === manager.id;
    if (!own) await assertTheatreAccess(manager, id);
    const detail = await selectOne<object>(`SELECT ${THEATRE_COLS} FROM theatres t WHERE t.id = $1`, [id]);
    return { ...detail, screens: await this.listScreens(id) };
  }

  /** Edit descriptive fields. Editing a REJECTED theatre the manager submitted resubmits it for review. */
  async update(manager: AuthUser, id: string, patch: Partial<TheatreInput>) {
    await sequelize.transaction(async (transaction) => {
      const t = await selectOne<{ status: string; submittedBy: string }>(
        'SELECT approval_status AS status, submitted_by AS "submittedBy" FROM theatres WHERE id = $1 FOR UPDATE',
        [id],
        transaction,
      );
      if (!t) throw notFound('Theatre');
      const assigned = await selectOne(
        'SELECT 1 AS ok FROM theatre_manager_assignments WHERE manager_id = $1 AND theatre_id = $2',
        [manager.id, id],
        transaction,
      );
      const mayEdit = manager.role === 'ADMIN' || assigned || (t.status === 'REJECTED' && t.submittedBy === manager.id);
      if (!mayEdit) throw notFound('Theatre');
      if (t.status === 'PENDING_APPROVAL' || t.status === 'SUSPENDED') {
        throw conflict(`A ${t.status.toLowerCase().replace('_', ' ')} theatre cannot be edited`);
      }
      const resubmit = t.status === 'REJECTED';
      await execute(
        `UPDATE theatres SET
            name = COALESCE($2, name), city = COALESCE($3, city), address = COALESCE($4, address),
            contact_number = COALESCE($5, contact_number), description = COALESCE($6, description),
            approval_status = $7, rejection_reason = CASE WHEN $8 THEN NULL ELSE rejection_reason END,
            updated_at = NOW()
          WHERE id = $1`,
        [id, patch.name ?? null, patch.city ?? null, patch.address ?? null, patch.contactNumber ?? null,
          patch.description ?? null, resubmit ? 'PENDING_APPROVAL' : t.status, resubmit],
        transaction,
      );
      if (resubmit) {
        await writeAudit(
          { actorUserId: manager.id, entityType: 'THEATRE', entityId: id, action: 'RESUBMITTED', previousStatus: 'REJECTED', newStatus: 'PENDING_APPROVAL' },
          transaction,
        );
      }
    });
    await this.cache.invalidate('theatres');
    return this.getForManager(manager, id);
  }

  async createScreen(
    theatreId: string,
    input: { name: string; rows: number; seatsPerRow: number; premiumRows: number; reclinerRows: number },
  ) {
    return sequelize.transaction(async (transaction) => {
      const created = await execute<{ id: string }>(
        `INSERT INTO screens (theatre_id, name) VALUES ($1, $2)
         ON CONFLICT (theatre_id, name) DO NOTHING RETURNING id`,
        [theatreId, input.name],
        transaction,
      );
      const screenId = created[0]?.id;
      if (!screenId) throw conflict('A screen with this name already exists in the theatre');
      // Rows are lettered A.. from the front; the LAST rows are the more premium ones.
      await execute(
        `INSERT INTO seats (screen_id, row_label, seat_number, seat_type)
         SELECT $1, chr(64 + r), n,
                CASE WHEN r > $3::int - $5::int THEN 'RECLINER'
                     WHEN r > $3::int - $5::int - $4::int THEN 'PREMIUM'
                     ELSE 'STANDARD' END
           FROM generate_series(1, $3::int) r, generate_series(1, $2::int) n`,
        [screenId, input.seatsPerRow, input.rows, input.premiumRows, input.reclinerRows],
        transaction,
      );
      return screenId;
    });
  }
}
