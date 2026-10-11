import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole, requireRoleAnyStatus } from '../../shared/middleware/auth';
import { uuidParam, validate } from '../../shared/middleware/validate';
import { asyncHandler } from '../../shared/utils/http';
import { ShowService } from '../shows/showService';
import { managerAccountStatus } from '../manager-approvals/managerApprovalService';
import { TheatreApprovalService } from '../theatre-approvals/theatreApprovalService';
import { assertTheatreAccess } from './theatreAccess';
import { TheatreService } from './theatreService';

const theatreBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    city: z.string().trim().min(2).max(80),
    address: z.string().trim().min(5).max(300),
    contactNumber: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, 'Enter a valid contact number'),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

const theatrePatch = theatreBody.partial();

const screenBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    rows: z.number().int().min(1).max(20),
    seatsPerRow: z.number().int().min(1).max(30),
    premiumRows: z.number().int().min(0).max(10).default(0),
    reclinerRows: z.number().int().min(0).max(5).default(0),
  })
  .strict()
  .refine((v) => v.premiumRows + v.reclinerRows <= v.rows, { message: 'Premium and recliner rows exceed total rows' });

const showBody = z
  .object({
    movieId: z.string().uuid(),
    screenId: z.string().uuid(),
    startTime: z.string().datetime({ offset: true }),
    prices: z.object({
      STANDARD: z.number().int().min(0).max(10_000_000),
      PREMIUM: z.number().int().min(0).max(10_000_000),
      RECLINER: z.number().int().min(0).max(10_000_000),
    }),
  })
  .strict();

const managedShowsQuery = z.object({
  theatreId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const publicQuery = z.object({ city: z.string().trim().max(80).optional() });

/** Public catalog: only APPROVED theatres are visible. */
export function theatreRoutes(theatres: TheatreService): Router {
  const r = Router();

  r.get(
    '/',
    validate({ query: publicQuery }),
    asyncHandler(async (req, res) => {
      res.json({ data: await theatres.listPublic((req.query as z.infer<typeof publicQuery>).city) });
    }),
  );
  r.get(
    '/:id',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      res.json({ data: await theatres.getPublic(req.params.id as string) });
    }),
  );
  r.get(
    '/:id/screens',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      res.json({ data: await theatres.listScreensPublic(req.params.id as string) });
    }),
  );
  return r;
}

export function showRoutes(shows: ShowService): Router {
  const r = Router();
  const query = z.object({
    movieId: z.string().uuid().optional(),
    theatreId: z.string().uuid().optional(),
    city: z.string().trim().max(80).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });
  r.get(
    '/',
    validate({ query }),
    asyncHandler(async (req, res) => {
      res.json({ data: await shows.listPublic(req.query as z.infer<typeof query>) });
    }),
  );
  r.get(
    '/:id/seats',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      res.json({ data: await shows.seatMap(req.params.id as string) });
    }),
  );
  return r;
}

export function managerRoutes(
  theatres: TheatreService,
  shows: ShowService,
  approvals: TheatreApprovalService,
  submitLimiter: import('express').RequestHandler,
): Router {
  const r = Router();
  r.use(authenticate);

  // Reachable by managers in ANY approval state so they can see where their application stands.
  r.get(
    '/account-status',
    requireRoleAnyStatus('THEATRE_MANAGER'),
    asyncHandler(async (req, res) => {
      res.json({ data: await managerAccountStatus(currentUser(req)) });
    }),
  );

  // Everything below requires an ACTIVE (approved) manager; admins may use the same operational routes.
  r.use(requireRole('THEATRE_MANAGER', 'ADMIN'));

  r.get(
    '/theatre-requests',
    asyncHandler(async (req, res) => {
      res.json({ data: await approvals.listForManager(currentUser(req)) });
    }),
  );
  r.get(
    '/theatres',
    asyncHandler(async (req, res) => {
      res.json({ data: await theatres.listForManager(currentUser(req)) });
    }),
  );
  r.post(
    '/theatres',
    requireRole('THEATRE_MANAGER'),
    submitLimiter,
    validate({ body: theatreBody }),
    asyncHandler(async (req, res) => {
      const id = await theatres.submit(currentUser(req), req.body as z.infer<typeof theatreBody>);
      res.status(201).json({ data: await theatres.getForManager(currentUser(req), id) });
    }),
  );
  r.get(
    '/theatres/:id',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      res.json({ data: await theatres.getForManager(currentUser(req), req.params.id as string) });
    }),
  );
  r.patch(
    '/theatres/:id',
    validate({ params: uuidParam(), body: theatrePatch }),
    asyncHandler(async (req, res) => {
      res.json({ data: await theatres.update(currentUser(req), req.params.id as string, req.body as z.infer<typeof theatrePatch>) });
    }),
  );
  r.post(
    '/theatres/:id/screens',
    validate({ params: uuidParam(), body: screenBody }),
    asyncHandler(async (req, res) => {
      const theatreId = req.params.id as string;
      await assertTheatreAccess(currentUser(req), theatreId, { requireApproved: true });
      const id = await theatres.createScreen(theatreId, req.body as z.infer<typeof screenBody>);
      res.status(201).json({ data: { id } });
    }),
  );
  r.get(
    '/theatres/:id/screens',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      await assertTheatreAccess(currentUser(req), req.params.id as string);
      res.json({ data: await theatres.listScreens(req.params.id as string) });
    }),
  );
  r.get(
    '/shows',
    validate({ query: managedShowsQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof managedShowsQuery>;
      const page = { page: q.page, pageSize: q.pageSize, limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
      const { rows, total } = await shows.listManaged(currentUser(req), q.theatreId, page);
      res.json({ data: rows, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) } });
    }),
  );
  r.post(
    '/shows',
    validate({ body: showBody }),
    asyncHandler(async (req, res) => {
      const id = await shows.create(currentUser(req), req.body as z.infer<typeof showBody>);
      res.status(201).json({ data: { id } });
    }),
  );
  r.patch(
    '/shows/:id/cancel',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      await shows.cancel(currentUser(req), req.params.id as string);
      res.json({ data: { id: req.params.id, status: 'CANCELLED' } });
    }),
  );

  return r;
}
