import rateLimit, { ipKeyGenerator, ClientRateLimitInfo, Options, RateLimitRequestHandler, Store } from 'express-rate-limit';
import { Request } from 'express';
import { CacheClient } from '../cache/clients';
import { moduleLogger } from '../logging/logger';
import { AuthedRequest } from './auth';

const log = moduleLogger('rate-limit');

/** In-process counters, used when Redis is absent or temporarily failing. */
class MemoryWindowStore implements Store {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  windowMs = 60_000;

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + this.windowMs };
      this.hits.set(key, fresh);
      return { totalHits: 1, resetTime: new Date(fresh.resetAt) };
    }
    entry.count += 1;
    return { totalHits: entry.count, resetTime: new Date(entry.resetAt) };
  }

  async decrement(key: string) {
    const entry = this.hits.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async resetKey(key: string) {
    this.hits.delete(key);
  }
}

/**
 * Shared Redis counters across instances. If Redis errors, we deliberately fall back to
 * per-process counters (fail-degraded, not fail-open) so limits keep applying.
 */
class ResilientStore implements Store {
  private readonly fallback = new MemoryWindowStore();
  private windowMs = 60_000;

  constructor(
    private readonly client: CacheClient,
    readonly prefix: string,
  ) {}

  init(options: Options) {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const { count, ttlMs } = await this.client.incrWindow(`${this.prefix}${key}`, this.windowMs);
      return { totalHits: count, resetTime: new Date(Date.now() + ttlMs) };
    } catch (err) {
      log.warn({ err }, 'rate-limit store unavailable; using in-process counters');
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string) {
    await this.fallback.decrement(key);
  }

  async resetKey(key: string) {
    await this.fallback.resetKey(key);
  }
}

export interface LimitSpec {
  name: string;
  windowMs: number;
  max: number;
  /** 'user' keys by authenticated user id (falling back to IP); default is IP. */
  keyBy?: 'ip' | 'user' | ((req: Request) => string);
}

export function makeLimiter(client: CacheClient, spec: LimitSpec): RateLimitRequestHandler {
  const store: Store =
    client.kind === 'memory' ? new MemoryWindowStore() : new ResilientStore(client, `mbp:rl:${spec.name}:`);
  return rateLimit({
    windowMs: spec.windowMs,
    limit: spec.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
    // Several limiters intentionally count the same client key (global read limit + route limits).
    validate: { xForwardedForHeader: false, trustProxy: false, singleCount: false },
    keyGenerator: (req) => {
      if (typeof spec.keyBy === 'function') return spec.keyBy(req);
      if (spec.keyBy === 'user') return (req as AuthedRequest).user?.id ?? ipKeyGenerator(req.ip ?? '');
      return ipKeyGenerator(req.ip ?? '');
    },
    handler: (req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(spec.windowMs / 1000));
      res.setHeader('Retry-After', String(res.getHeader('Retry-After') ?? retryAfter));
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.', requestId: req.id },
      });
    },
  });
}
