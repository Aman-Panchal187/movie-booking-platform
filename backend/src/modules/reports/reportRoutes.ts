import { Router } from 'express';
import { z } from 'zod';
import { AppError, forbidden } from '../../shared/errors/errors';
import { AuthUser, authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import { asyncHandler, pageMeta, paginationQuery, toPage } from '../../shared/utils/http';
import { operableTheatreIds } from '../theatres/theatreAccess';
import { ReportService, ReportScope } from './reportService';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const reportQuery = paginationQuery.extend({
  range: z.enum(['today', '7d', '30d', 'custom']).default('7d'),
  from: date.optional(),
  to: date.optional(),
  theatreId: z.string().uuid().optional(),
});

type Q = z.infer<typeof reportQuery>;

/** Manager scope: only approved theatres they are assigned to; a requested theatreId must be one of them. */
async function managerScope(user: AuthUser, theatreId?: string): Promise<ReportScope> {
  const mine = await operableTheatreIds(user);
  if (!theatreId) return { theatreIds: mine };
  if (!mine.includes(theatreId)) throw forbidden('You can only view reports for your approved, assigned theatres');
  return { theatreIds: [theatreId] };
}

function parse(req: { query: unknown }): Q {
  return req.query as Q;
}

export function managerReportRoutes(reports: ReportService): Router {
  const r = Router();
  r.use(authenticate, requireRole('THEATRE_MANAGER'), validate({ query: reportQuery }));

  r.get('/summary', asyncHandler(async (req, res) => {
    const q = parse(req);
    res.json({ data: await reports.summary(await managerScope(currentUser(req), q.theatreId), q) });
  }));
  r.get('/revenue', asyncHandler(async (req, res) => {
    const q = parse(req);
    res.json({ data: await reports.revenueSeries(await managerScope(currentUser(req), q.theatreId), q) });
  }));
  r.get('/bookings', asyncHandler(async (req, res) => {
    const q = parse(req);
    const page = toPage(q);
    const result = await reports.bookings(await managerScope(currentUser(req), q.theatreId), q, page);
    res.json({ data: result, meta: pageMeta(page, result.total) });
  }));
  r.get('/occupancy', asyncHandler(async (req, res) => {
    const q = parse(req);
    res.json({ data: await reports.occupancy(await managerScope(currentUser(req), q.theatreId), q) });
  }));
  return r;
}

export function adminReportRoutes(reports: ReportService): Router {
  const r = Router();
  r.use(authenticate, requireRole('ADMIN'), validate({ query: reportQuery }));
  const all: ReportScope = { theatreIds: null };

  r.get('/summary', asyncHandler(async (req, res) => {
    const q = parse(req);
    const [summary, totals] = await Promise.all([reports.summary(q.theatreId ? { theatreIds: [q.theatreId] } : all, q), reports.platformTotals()]);
    res.json({ data: { ...summary, ...totals } });
  }));
  r.get('/revenue', asyncHandler(async (req, res) => {
    const q = parse(req);
    res.json({ data: await reports.revenueSeries(q.theatreId ? { theatreIds: [q.theatreId] } : all, q) });
  }));
  r.get('/bookings', asyncHandler(async (req, res) => {
    const q = parse(req);
    const page = toPage(q);
    const result = await reports.bookings(q.theatreId ? { theatreIds: [q.theatreId] } : all, q, page);
    res.json({ data: result, meta: pageMeta(page, result.total) });
  }));
  r.get('/theatres', asyncHandler(async (req, res) => {
    if (parse(req).range === 'custom' && !parse(req).from) throw new AppError(422, 'VALIDATION_ERROR', 'Custom range needs from and to');
    res.json({ data: await reports.theatreBreakdown(parse(req)) });
  }));
  return r;
}
