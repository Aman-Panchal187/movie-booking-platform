import { Redis as UpstashRedis } from '@upstash/redis';
import IORedis from 'ioredis';
import { Env } from '../config/env';

/** Minimal key/value surface shared by Upstash REST, Redis TCP and the in-memory client. */
export interface CacheClient {
  readonly kind: 'upstash' | 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomically increments a counter, setting its expiry on first use. Returns count and ms to expiry. */
  incrWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

class UpstashClient implements CacheClient {
  readonly kind = 'upstash' as const;
  private readonly redis: UpstashRedis;

  constructor(url: string, token: string) {
    this.redis = new UpstashRedis({ url, token, retry: { retries: 1 } });
  }

  async get(key: string) {
    const v = await this.redis.get<unknown>(key);
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(key, value, { ex: ttlSeconds });
  }

  async del(key: string) {
    await this.redis.del(key);
  }

  async incrWindow(key: string, windowMs: number) {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, windowMs);
    const ttl = await this.redis.pttl(key);
    return { count, ttlMs: ttl > 0 ? ttl : windowMs };
  }

  async ping() {
    return (await this.redis.ping()) === 'PONG';
  }

  async close() {
    // REST client holds no connection.
  }
}

class TcpRedisClient implements CacheClient {
  readonly kind = 'redis' as const;
  private readonly redis: IORedis;

  constructor(url: string) {
    this.redis = new IORedis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    // Connection errors surface through rejected commands; avoid unhandled 'error' events.
    this.redis.on('error', () => undefined);
  }

  async get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(key: string) {
    await this.redis.del(key);
  }

  async incrWindow(key: string, windowMs: number) {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, windowMs);
    const ttl = await this.redis.pttl(key);
    return { count, ttlMs: ttl > 0 ? ttl : windowMs };
  }

  async ping() {
    return (await this.redis.ping()) === 'PONG';
  }

  async close() {
    this.redis.disconnect();
  }
}

/** Per-process fallback used when no Redis is configured, and by tests. */
export class MemoryClient implements CacheClient {
  readonly kind = 'memory' as const;
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  /** Test hook: simulate an outage. */
  failing = false;

  private guard() {
    if (this.failing) throw new Error('memory cache simulated outage');
  }

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string) {
    this.guard();
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.guard();
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string) {
    this.guard();
    this.store.delete(key);
  }

  async incrWindow(key: string, windowMs: number) {
    this.guard();
    const existing = this.live(key);
    const count = existing ? Number(existing.value) + 1 : 1;
    const expiresAt = existing ? existing.expiresAt : Date.now() + windowMs;
    this.store.set(key, { value: String(count), expiresAt });
    return { count, ttlMs: expiresAt - Date.now() };
  }

  async ping() {
    this.guard();
    return true;
  }

  async close() {
    this.store.clear();
  }
}

/** Upstash REST takes priority, then Redis TCP, then in-process memory. */
export function createCacheClient(e: Env): CacheClient {
  if (e.UPSTASH_REDIS_REST_URL && e.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashClient(e.UPSTASH_REDIS_REST_URL, e.UPSTASH_REDIS_REST_TOKEN);
  }
  if (e.REDIS_URL) return new TcpRedisClient(e.REDIS_URL);
  return new MemoryClient();
}
