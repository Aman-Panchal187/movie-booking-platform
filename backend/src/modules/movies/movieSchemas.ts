import { z } from 'zod';

const httpsUrl = z
  .string()
  .url()
  .max(1000)
  .refine((u) => u.startsWith('https://'), 'URL must use https');

const nullableUrl = httpsUrl.nullable().optional();

export const movieBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).default(''),
    language: z.string().trim().min(1).max(60),
    genre: z.string().trim().min(1).max(60),
    durationMinutes: z.number().int().min(1).max(600),
    releaseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    certification: z.string().trim().min(1).max(10).default('U'),
    posterUrl: nullableUrl,
    bannerUrl: nullableUrl,
    trailerUrl: nullableUrl,
    isActive: z.boolean().optional(),
  })
  .strict();

export const moviePatch = movieBody.partial().extend({ description: z.string().trim().max(4000).optional() });

export const movieQuery = z.object({
  q: z.string().trim().max(100).optional(),
  genre: z.string().trim().max(60).optional(),
  language: z.string().trim().max(60).optional(),
  city: z.string().trim().max(80).optional(),
});
