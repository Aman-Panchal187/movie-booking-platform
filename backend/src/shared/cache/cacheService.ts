import { cacheEvents } from '../observability/metrics';
import { moduleLogger } from '../logging/logger';
import { CacheClient } from './clients';

const log = moduleLogger('cache');

export type CacheNamespace = 'movies' | 'theatres' | 'shows' | 'reports';

export const TTL = {
  movieList: 300,
  movieDetail: 600,
  theatreList: 300,
  shows: 60,
  reports: 30,
} as const;

/**
 * Cache-aside with namespace versioning: invalidating a namespace bumps its version so old
 * keys are simply never read again (no SCAN/KEYS needed). Any cache failure falls back to the loader.
 */
export class CacheService {
  readonly stats = { hits: 0, misses: 0, errors: 0 };

  constructor(private readonly client: CacheClient) {}

  private versionKey(ns: CacheNamespace) {
    return `mbp:ver:${ns}`;
  }

  private async version(ns: CacheNamespace): Promise<string> {
    return (await this.client.get(this.versionKey(ns))) ?? '0';
  }

  async getOrSet<T>(ns: CacheNamespace, key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    let fullKey: string;
    try {
      fullKey = `mbp:${ns}:v${await this.version(ns)}:${key}`;
      const raw = await this.client.get(fullKey);
      if (raw !== null) {
        this.stats.hits += 1;
        cacheEvents.inc({ result: 'hit' });
        return JSON.parse(raw) as T;
      }
    } catch (err) {
      return this.degraded(err, loader);
    }
    this.stats.misses += 1;
    cacheEvents.inc({ result: 'miss' });
    const value = await loader();
    try {
      await this.client.set(fullKey, JSON.stringify(value), ttlSeconds);
    } catch (err) {
      this.recordError(err);
    }
    return value;
  }

  async invalidate(...namespaces: CacheNamespace[]): Promise<void> {
    for (const ns of namespaces) {
      try {
        const next = Number(await this.version(ns)) + 1;
        await this.client.set(this.versionKey(ns), String(next), 60 * 60 * 24 * 30);
      } catch (err) {
        this.recordError(err);
      }
    }
  }

  async healthy(): Promise<boolean> {
    try {
      return await this.client.ping();
    } catch {
      return false;
    }
  }

  get backend() {
    return this.client.kind;
  }

  private recordError(err: unknown) {
    this.stats.errors += 1;
    cacheEvents.inc({ result: 'error' });
    log.warn({ err }, 'cache operation failed; continuing without cache');
  }

  private async degraded<T>(err: unknown, loader: () => Promise<T>): Promise<T> {
    this.recordError(err);
    return loader();
  }
}
