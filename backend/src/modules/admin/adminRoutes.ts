import { RequestHandler, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { AppError } from '../../shared/errors/errors';
import { authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import { uuidParam, validate } from '../../shared/middleware/validate';
import { asyncHandler, pageMeta, paginationQuery, toPage } from '../../shared/utils/http';
import { listAudit } from '../audit/auditService';
import { decideManager, listManagerRequests } from '../manager-approvals/managerApprovalService';
import { MAX_IMAGE_BYTES, MediaService } from '../media/mediaService';
import { movieBody, moviePatch } from '../movies/movieSchemas';
import { MovieInput, MovieService } from '../movies/movieService';
import { listAllBookings, listAllPayments } from '../reports/adminListings';
import { TheatreApprovalService } from '../theatre-approvals/theatreApprovalService';
import { listUsers, setAccountSuspended } from '../users/userService';

const q = z.string().trim().max(100).optional();
const listQuery = paginationQuery.extend({ status: z.string().max(30).optional(), q });

const managerDecision = z
  .object({
    action: z.enum(['APPROVE', 'REJECT', 'SUSPEND', 'REACTIVATE']),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((v) => v.action !== 'REJECT' || Boolean(v.reason), { path: ['reason'], message: 'A reason is required to reject' });

const theatreDecision = z
  .object({
    action: z.enum(['APPROVE', 'REJECT', 'SUSPEND', 'REINSTATE']),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((v) => v.action !== 'REJECT' || Boolean(v.reason), { path: ['reason'], message: 'A reason is required to reject' });

const userStatusBody = z
  .object({ action: z.enum(['SUSPEND', 'REACTIVATE']), reason: z.string().trim().max(500).optional() })
  .strict();

const assignBody = z.object({ managerId: z.string().uuid() }).strict();

interface Deps {
  movies: MovieService;
  theatreApprovals: TheatreApprovalService;
  media: MediaService;
  decisionLimiter: RequestHandler;
  uploadLimiter: RequestHandler;
}

export function adminRoutes(d: Deps): Router {
  const r = Router();
  r.use(authenticate, requireRole('ADMIN'));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

  // ---- Manager account approvals (Level 1)
  r.get('/manager-requests', validate({ query: listQuery }), asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuery>;
    const page = toPage(query);
    const { rows, total } = await listManagerRequests(page, query.status, query.q);
    res.json({ data: rows, meta: pageMeta(page, total) });
  }));
  r.patch('/manager-requests/:id', d.decisionLimiter, validate({ params: uuidParam(), body: managerDecision }), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof managerDecision>;
    res.json({ data: await decideManager(currentUser(req), req.params.id as string, body.action, body.reason) });
  }));

  // ---- Theatre approvals (Level 2) and assignments
  r.get('/theatre-requests', validate({ query: listQuery }), asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuery>;
    const page = toPage(query);
    const { rows, total } = await d.theatreApprovals.list(page, query.status, query.q);
    res.json({ data: rows, meta: pageMeta(page, total) });
  }));
  r.patch('/theatre-requests/:id', d.decisionLimiter, validate({ params: uuidParam(), body: theatreDecision }), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof theatreDecision>;
    res.json({ data: await d.theatreApprovals.decide(currentUser(req), req.params.id as string, body.action, body.reason) });
  }));
  r.post('/theatres/:id/managers', d.decisionLimiter, validate({ params: uuidParam(), body: assignBody }), asyncHandler(async (req, res) => {
    await d.theatreApprovals.assignManager(currentUser(req), req.params.id as string, (req.body as z.infer<typeof assignBody>).managerId);
    res.status(201).json({ data: { assigned: true } });
  }));
  r.delete('/theatres/:id/managers/:managerId', d.decisionLimiter,
    validate({ params: z.object({ id: z.string().uuid(), managerId: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      await d.theatreApprovals.revokeManager(currentUser(req), req.params.id as string, req.params.managerId as string);
      res.json({ data: { revoked: true } });
    }));

  // ---- Users
  r.get('/users', validate({ query: listQuery.extend({ role: z.enum(['CUSTOMER', 'THEATRE_MANAGER', 'ADMIN']).optional() }) }), asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuery> & { role?: string };
    const page = toPage(query);
    const { rows, total } = await listUsers(page, { role: query.role, status: query.status, q: query.q });
    res.json({ data: rows, meta: pageMeta(page, total) });
  }));
  r.patch('/users/:id/status', d.decisionLimiter, validate({ params: uuidParam(), body: userStatusBody }), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof userStatusBody>;
    await setAccountSuspended(currentUser(req), req.params.id as string, body.action === 'SUSPEND', body.reason);
    res.json({ data: { updated: true } });
  }));

  // ---- Movies
  r.get('/movies', validate({ query: paginationQuery.extend({ q }) }), asyncHandler(async (req, res) => {
    const query = req.query as unknown as { page: number; pageSize: number; q?: string };
    const page = toPage(query);
    const { rows, total } = await d.movies.listAdmin(page, query.q);
    res.json({ data: rows, meta: pageMeta(page, total) });
  }));
  r.post('/movies', validate({ body: movieBody }), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await d.movies.create(req.body as MovieInput) });
  }));
  r.patch('/movies/:id', validate({ params: uuidParam(), body: moviePatch }), asyncHandler(async (req, res) => {
    res.json({ data: await d.movies.update(req.params.id as string, req.body as Partial<MovieInput>) });
  }));

  // ---- Media (Cloudinary). Fails with 503 when credentials are not configured.
  r.get('/media/status', (_req, res) => {
    res.json({ data: { cloudinaryConfigured: d.media.isConfigured } });
  });
  r.post('/media/upload', d.uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
    const kind = z.enum(['poster', 'banner']).safeParse(req.body?.kind);
    if (!kind.success) throw new AppError(422, 'VALIDATION_ERROR', 'kind must be "poster" or "banner"');
    if (!req.file) throw new AppError(422, 'VALIDATION_ERROR', 'A file field named "file" is required');
    res.status(201).json({ data: await d.media.uploadImage(req.file, kind.data) });
  }));

  // ---- Platform visibility
  r.get('/bookings', validate({ query: listQuery }), asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuery>;
    const page = toPage(query);
    const { rows, total } = await listAllBookings(page, { status: query.status, q: query.q });
    res.json({ data: rows, meta: pageMeta(page, total) });
  }));
  r.get('/payments', validate({ query: listQuery }), asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuery>;
    const page = toPage(query);
    const { rows, total } = await listAllPayments(page, { status: query.status });
    res.json({ data: rows, meta: pageMeta(page, total) });
  }));
  r.get('/audit-logs', validate({ query: paginationQuery.extend({ entityType: z.string().max(40).optional(), q }) }), asyncHandler(async (req, res) => {
    const query = req.query as unknown as { page: number; pageSize: number; entityType?: string; q?: string };
    const page = toPage(query);
    const { rows, total } = await listAudit(page, { entityType: query.entityType, q: query.q });
    res.json({ data: rows, meta: pageMeta(page, total) });
  }));

  return r;
}
