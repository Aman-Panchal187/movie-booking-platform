import { RequestHandler } from 'express';
import { ZodTypeAny, z } from 'zod';
import { AppError } from '../errors/errors';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/** Validates and replaces body/query/params with parsed values. Failures are HTTP 422. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return next(new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', details));
      }
      Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
    }
    next();
  };
}

export const uuidParam = (name = 'id') => z.object({ [name]: z.string().uuid() });
