import { CacheService, TTL } from '../../shared/cache/cacheService';
import { execute, selectOne, selectRows } from '../../shared/database/sequelize';
import { notFound } from '../../shared/errors/errors';
import { Page, likePattern } from '../../shared/utils/http';

export const MOVIE_COLS = `m.id, m.title, m.description, m.language, m.genre,
  m.duration_minutes AS "durationMinutes", m.release_date AS "releaseDate", m.certification,
  m.poster_url AS "posterUrl", m.banner_url AS "bannerUrl", m.trailer_url AS "trailerUrl",
  m.is_active AS "isActive"`;

export interface MovieFilter {
  q?: string;
  genre?: string;
  language?: string;
  city?: string;
}

export interface MovieInput {
  title: string;
  description: string;
  language: string;
  genre: string;
  durationMinutes: number;
  releaseDate?: string | null;
  certification: string;
  posterUrl?: string | null;
  bannerUrl?: string | null;
  trailerUrl?: string | null;
  isActive?: boolean;
}

export class MovieService {
  constructor(private readonly cache: CacheService) {}

  listPublic(filter: MovieFilter) {
    return this.cache.getOrSet('movies', `list:${JSON.stringify(filter)}`, TTL.movieList, () =>
      selectRows(
        `SELECT ${MOVIE_COLS}, COALESCE(s.upcoming, 0)::int AS "upcomingShows"
           FROM movies m
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS upcoming
               FROM shows sh
               JOIN screens sc ON sc.id = sh.screen_id AND sc.is_active
               JOIN theatres t ON t.id = sc.theatre_id AND t.approval_status = 'APPROVED'
              WHERE sh.movie_id = m.id AND sh.status = 'SCHEDULED' AND sh.start_time > NOW()
                AND ($4::text IS NULL OR t.city ILIKE $4)
           ) s ON TRUE
          WHERE m.is_active
            AND ($1::text IS NULL OR m.title ILIKE $1)
            AND ($2::text IS NULL OR m.genre ILIKE $2)
            AND ($3::text IS NULL OR m.language ILIKE $3)
            AND ($4::text IS NULL OR COALESCE(s.upcoming, 0) > 0)
          ORDER BY m.release_date DESC NULLS LAST, m.title`,
        [
          filter.q ? likePattern(filter.q) : null,
          filter.genre ? likePattern(filter.genre) : null,
          filter.language ? likePattern(filter.language) : null,
          filter.city ? likePattern(filter.city) : null,
        ],
      ),
    );
  }

  async getPublic(id: string) {
    const movie = await this.cache.getOrSet('movies', `detail:${id}`, TTL.movieDetail, () =>
      selectOne(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.id = $1 AND m.is_active`, [id]),
    );
    if (!movie) throw notFound('Movie');
    return movie;
  }

  async listAdmin(page: Page, q?: string) {
    const bind = [q ? likePattern(q) : null];
    const total = await selectOne<{ count: string }>(
      'SELECT COUNT(*) FROM movies m WHERE ($1::text IS NULL OR m.title ILIKE $1)',
      bind,
    );
    const rows = await selectRows(
      `SELECT ${MOVIE_COLS} FROM movies m WHERE ($1::text IS NULL OR m.title ILIKE $1)
        ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
      [...bind, page.limit, page.offset],
    );
    return { rows, total: Number(total?.count ?? 0) };
  }

  async create(input: MovieInput) {
    const [row] = await execute<{ id: string }>(
      `INSERT INTO movies (title, description, language, genre, duration_minutes, release_date,
                           certification, poster_url, banner_url, trailer_url, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        input.title,
        input.description,
        input.language,
        input.genre,
        input.durationMinutes,
        input.releaseDate ?? null,
        input.certification,
        input.posterUrl ?? null,
        input.bannerUrl ?? null,
        input.trailerUrl ?? null,
        input.isActive ?? true,
      ],
    );
    await this.cache.invalidate('movies', 'shows');
    return selectOne(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.id = $1`, [row!.id]);
  }

  async update(id: string, patch: Partial<MovieInput>) {
    const columns: Record<keyof MovieInput, string> = {
      title: 'title',
      description: 'description',
      language: 'language',
      genre: 'genre',
      durationMinutes: 'duration_minutes',
      releaseDate: 'release_date',
      certification: 'certification',
      posterUrl: 'poster_url',
      bannerUrl: 'banner_url',
      trailerUrl: 'trailer_url',
      isActive: 'is_active',
    };
    const sets: string[] = [];
    const bind: unknown[] = [id];
    for (const [key, value] of Object.entries(patch) as [keyof MovieInput, unknown][]) {
      if (value === undefined) continue;
      bind.push(value);
      sets.push(`${columns[key]} = $${bind.length}`);
    }
    if (sets.length > 0) {
      const updated = await execute(`UPDATE movies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING id`, bind);
      if (updated.length === 0) throw notFound('Movie');
      await this.cache.invalidate('movies', 'shows');
    }
    const movie = await selectOne(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.id = $1`, [id]);
    if (!movie) throw notFound('Movie');
    return movie;
  }
}
