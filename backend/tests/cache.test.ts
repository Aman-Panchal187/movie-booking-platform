import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../src/shared/cache/cacheService';
import { MemoryClient } from '../src/shared/cache/clients';
import { execute } from '../src/shared/database/sequelize';
import { auth, buildApp, createMovie, createUser, resetData } from './helpers';

describe('CacheService', () => {
  it('misses, then hits, then expires by TTL', async () => {
    vi.useFakeTimers();
    const cache = new CacheService(new MemoryClient());
    const loader = vi.fn(async () => ({ v: 1 }));
    await cache.getOrSet('movies', 'k', 5, loader);
    await cache.getOrSet('movies', 'k', 5, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1 });
    vi.advanceTimersByTime(6000);
    await cache.getOrSet('movies', 'k', 5, loader);
    expect(loader).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('invalidation bumps the namespace so the next read reloads', async () => {
    const cache = new CacheService(new MemoryClient());
    let n = 0;
    const loader = async () => ++n;
    expect(await cache.getOrSet('movies', 'k', 60, loader)).toBe(1);
    expect(await cache.getOrSet('movies', 'k', 60, loader)).toBe(1);
    await cache.invalidate('movies');
    expect(await cache.getOrSet('movies', 'k', 60, loader)).toBe(2);
    // other namespaces are untouched
    expect(await cache.getOrSet('theatres', 'k', 60, loader)).toBe(3);
    await cache.invalidate('movies');
    expect(await cache.getOrSet('theatres', 'k', 60, loader)).toBe(3);
  });

  it('falls back to the loader when the cache backend is down', async () => {
    const client = new MemoryClient();
    const cache = new CacheService(client);
    client.failing = true;
    expect(await cache.getOrSet('movies', 'k', 60, async () => 'from-db')).toBe('from-db');
    expect(cache.stats.errors).toBeGreaterThan(0);
    await expect(cache.invalidate('movies')).resolves.toBeUndefined();
    expect(await cache.healthy()).toBe(false);
  });
});

describe('cached catalog endpoints', () => {
  const handle = buildApp();
  beforeEach(async () => {
    await resetData();
    handle.memory.failing = false;
    await handle.cache.invalidate('movies', 'theatres', 'shows', 'reports');
  });

  it('serves movies from cache and sees admin updates immediately after invalidation', async () => {
    const movieId = await createMovie();
    const admin = await createUser('ADMIN');
    const before = handle.cache.stats.hits;
    const first = await request(handle.app).get('/api/movies');
    const second = await request(handle.app).get('/api/movies');
    expect(second.body).toEqual(first.body);
    expect(handle.cache.stats.hits).toBeGreaterThan(before);

    // Mutating the DB behind the cache keeps the stale copy until the API write path invalidates it.
    await execute("UPDATE movies SET title = 'Edited Directly' WHERE id = $1", [movieId]);
    expect((await request(handle.app).get('/api/movies')).body.data[0].title).not.toBe('Edited Directly');

    const patched = await request(handle.app).patch(`/api/admin/movies/${movieId}`).set(auth(admin)).send({ title: 'Edited Via API' });
    expect(patched.status).toBe(200);
    expect((await request(handle.app).get('/api/movies')).body.data[0].title).toBe('Edited Via API');
  });

  it('keeps serving catalog reads from PostgreSQL when the cache is unavailable', async () => {
    await createMovie();
    handle.memory.failing = true;
    const res = await request(handle.app).get('/api/movies');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const ready = await request(handle.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('degraded');
    handle.memory.failing = false;
  });

  it('seat availability is never cached', async () => {
    const { createVenue, hold } = await import('./helpers.js');
    const manager = await createUser('THEATRE_MANAGER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(manager);
    const read = async () => (await request(handle.app).get(`/api/shows/${venue.showId}/seats`)).body.data.seats.filter((s: { status: string }) => s.status === 'HELD').length;
    expect(await read()).toBe(0);
    await hold(handle.app, customer, venue.showId, [venue.showSeatIds[0]!]);
    expect(await read()).toBe(1);
  });
});
