import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import { uuidParam, validate } from '../../shared/middleware/validate';
import { asyncHandler, pageMeta, paginationQuery, toPage } from '../../shared/utils/http';
import { BookingService } from './bookingService';

const holdBody = z
  .object({
    showId: z.string().uuid(),
    showSeatIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict();

export function bookingRoutes(service: BookingService, holdLimiter: RequestHandler): Router {
  const r = Router();
  r.use(authenticate, requireRole('CUSTOMER', 'ADMIN'));

  r.post(
    '/hold',
    requireRole('CUSTOMER'),
    holdLimiter,
    validate({ body: holdBody }),
    asyncHandler(async (req, res) => {
      const { showId, showSeatIds } = req.body as z.infer<typeof holdBody>;
      res.status(201).json({ data: await service.hold(currentUser(req), showId, showSeatIds) });
    }),
  );

  r.get(
    '/',
    validate({ query: paginationQuery }),
    asyncHandler(async (req, res) => {
      const page = toPage(req.query as unknown as z.infer<typeof paginationQuery>);
      const { rows, total } = await service.listForUser(currentUser(req), page);
      res.json({ data: rows, meta: pageMeta(page, total) });
    }),
  );

  r.get(
    '/:id',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.getForUser(currentUser(req), req.params.id as string) });
    }),
  );

  return r;
}

export function ticketRoutes(service: BookingService): Router {
  const r = Router();
  r.use(authenticate, requireRole('CUSTOMER', 'ADMIN'));

  r.get(
    '/:id',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.getTicket(currentUser(req), req.params.id as string) });
    }),
  );

  return r;
}
