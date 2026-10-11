import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors/errors';
import { authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import { asyncHandler } from '../../shared/utils/http';
import { PaymentService } from './paymentService';

const paymentBody = z
  .object({
    bookingId: z.string().uuid(),
    amountMinor: z.number().int().min(0),
    cardNumber: z.string().regex(/^\d{12,19}$/, 'Card number must be 12-19 digits'),
    cardHolder: z.string().trim().min(2).max(80),
  })
  .strict();

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export function paymentRoutes(service: PaymentService, limiter: RequestHandler): Router {
  const r = Router();

  r.post(
    '/',
    authenticate,
    requireRole('CUSTOMER'),
    limiter,
    validate({ body: paymentBody }),
    asyncHandler(async (req, res) => {
      const key = req.header('idempotency-key');
      if (!key || !IDEMPOTENCY_KEY.test(key)) {
        throw new AppError(422, 'VALIDATION_ERROR', 'A valid Idempotency-Key header (8-128 URL-safe characters) is required');
      }
      const result = await service.pay(currentUser(req), key, req.body as z.infer<typeof paymentBody>);
      if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
      res.status(result.httpStatus).json({ data: result.body });
    }),
  );

  return r;
}
