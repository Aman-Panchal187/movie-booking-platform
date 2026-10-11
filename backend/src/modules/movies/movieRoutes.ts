import { Router } from 'express';
import { z } from 'zod';
import { validate, uuidParam } from '../../shared/middleware/validate';
import { asyncHandler } from '../../shared/utils/http';
import { MovieService } from './movieService';
import { movieQuery } from './movieSchemas';

export function movieRoutes(service: MovieService): Router {
  const r = Router();

  r.get(
    '/',
    validate({ query: movieQuery }),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.listPublic(req.query as z.infer<typeof movieQuery>) });
    }),
  );

  r.get(
    '/:id',
    validate({ params: uuidParam() }),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.getPublic(req.params.id as string) });
    }),
  );

  return r;
}
