import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import { asyncHandler } from '../../shared/utils/http';
import { loginUser, registerUser } from './authService';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

// .strict() makes any extra field (e.g. role: "ADMIN") a validation error.
const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().toLowerCase().email().max(254),
    password,
    confirmPassword: z.string(),
  })
  .strict()
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

const loginSchema = z
  .object({ email: z.string().trim().email(), password: z.string().min(1).max(200) })
  .strict();

export interface AuthLimiters {
  login: RequestHandler[];
  register: RequestHandler;
}

export function authRoutes(limiters: AuthLimiters): Router {
  const r = Router();

  r.post(
    '/register',
    limiters.register,
    validate({ body: registerSchema }),
    asyncHandler(async (req, res) => {
      const { name, email, password: pw } = req.body as z.infer<typeof registerSchema>;
      const result = await registerUser({ name, email, password: pw, role: 'CUSTOMER' });
      res.status(201).json({ data: result });
    }),
  );

  r.post(
    '/register-manager',
    limiters.register,
    validate({ body: registerSchema }),
    asyncHandler(async (req, res) => {
      const { name, email, password: pw } = req.body as z.infer<typeof registerSchema>;
      const result = await registerUser({ name, email, password: pw, role: 'THEATRE_MANAGER' });
      res.status(201).json({ data: result });
    }),
  );

  r.post(
    '/login',
    ...limiters.login,
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      const { email, password: pw } = req.body as z.infer<typeof loginSchema>;
      res.json({ data: await loginUser(email, pw) });
    }),
  );

  r.get('/me', authenticate, (req, res) => {
    res.json({ data: { user: currentUser(req) } });
  });

  return r;
}
