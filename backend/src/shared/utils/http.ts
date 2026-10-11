import { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Forwards rejected promises to Express error middleware. */
export const asyncHandler =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Page {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

export function toPage(q: { page: number; pageSize: number }): Page {
  return { page: q.page, pageSize: q.pageSize, limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
}

export function pageMeta(page: Page, total: number) {
  return { page: page.page, pageSize: page.pageSize, total, totalPages: Math.ceil(total / page.pageSize) };
}

/** Escapes LIKE wildcards so user search text matches literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
