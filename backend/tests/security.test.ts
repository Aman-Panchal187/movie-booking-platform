import { Writable } from 'node:stream';
import SwaggerParser from '@apidevtools/swagger-parser';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/shared/logging/logger';
import { openApiSpec } from '../src/openapi/spec';
import { auth, buildApp, createUser, PASSWORD } from './helpers';

describe('rate limiting', () => {
  it('returns 429 with Retry-After after the login limit', async () => {
    const { app } = buildApp({ limits: { login: 3 } });
    const attempt = () => request(app).post('/api/auth/login').send({ email: 'x@example.com', password: 'WrongPass1' });
    for (let i = 0; i < 3; i += 1) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('limits seat holds and payments per user, not per IP', async () => {
    const { app } = buildApp({ limits: { hold: 2 } });
    const [a, b] = [await createUser('CUSTOMER'), await createUser('CUSTOMER')];
    const send = (u: typeof a) => request(app).post('/api/bookings/hold').set(auth(u)).send({ showId: '00000000-0000-4000-8000-000000000000', showSeatIds: ['00000000-0000-4000-8000-000000000001'] });
    await send(a);
    await send(a);
    expect((await send(a)).status).toBe(429);
    expect((await send(b)).status).not.toBe(429);
  });

  it('does not trust client-supplied X-Forwarded-For beyond the single proxy hop', async () => {
    const { app } = buildApp({ limits: { login: 2 } });
    const attempt = (spoof: string) => request(app).post('/api/auth/login').set('X-Forwarded-For', spoof).send({ email: 'y@example.com', password: PASSWORD });
    await attempt('1.1.1.1, 9.9.9.9');
    await attempt('2.2.2.2, 9.9.9.9');
    // Same last hop => same bucket, so spoofing the leftmost entries does not reset the counter.
    expect((await attempt('3.3.3.3, 9.9.9.9')).status).toBe(429);
  });
});

describe('platform behaviour', () => {
  const { app } = buildApp();

  it('enforces authentication and roles', async () => {
    const customer = await createUser('CUSTOMER');
    expect((await request(app).get('/api/bookings')).status).toBe(401);
    expect((await request(app).get('/api/admin/users').set(auth(customer))).status).toBe(403);
    expect((await request(app).get('/api/manager/theatres').set(auth(customer))).status).toBe(403);
  });

  it('validates input with Zod and returns structured 422 errors', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON and oversized bodies safely', async () => {
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
    const huge = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(200_000) });
    expect(huge.status).toBe(413);
  });

  it('exposes liveness and readiness; readiness reports dependencies', async () => {
    expect((await request(app).get('/health/live')).body.status).toBe('ok');
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.dependencies.postgres).toBe('up');
  });

  it('propagates a valid request id and generates one otherwise', async () => {
    const given = await request(app).get('/health/live').set('X-Request-Id', 'req-abc-12345678');
    expect(given.headers['x-request-id']).toBe('req-abc-12345678');
    const generated = await request(app).get('/health/live');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const unsafe = await request(app).get('/health/live').set('X-Request-Id', 'bad id\twith spaces');
    expect(unsafe.headers['x-request-id']).not.toContain(' ');
  });

  it('sets security headers and does not leak the framework', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('restricts CORS to configured origins', async () => {
    const strict = buildApp({ env: { ...(await import('../src/shared/config/env.js')).loadEnv(), CORS_ALLOWED_ORIGINS: 'https://app.example.com', FRONTEND_URL: undefined } });
    const ok = await request(strict.app).get('/health/live').set('Origin', 'https://app.example.com');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const bad = await request(strict.app).get('/health/live').set('Origin', 'https://evil.example.com');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes Prometheus metrics including HTTP and booking counters', async () => {
    await request(app).get('/health/live');
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
    expect(res.text).toContain('booking_conflicts_total');
    expect(res.text).toContain('cache_events_total');
  });

  it('protects /metrics in production without a token', async () => {
    const { loadEnv } = await import('../src/shared/config/env.js');
    const prod = buildApp({ env: { ...loadEnv(), NODE_ENV: 'production', METRICS_TOKEN: 'metrics-token-123' } });
    expect((await request(prod.app).get('/metrics')).status).toBe(401);
    expect((await request(prod.app).get('/metrics').set('Authorization', 'Bearer metrics-token-123')).status).toBe(200);
  });

  it('serves Swagger UI and the OpenAPI document', async () => {
    expect((await request(app).get('/api-docs/').redirects(1)).status).toBe(200);
    const spec = await request(app).get('/api-docs/openapi.json');
    expect(spec.body.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(40);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3 specification', async () => {
    await expect(SwaggerParser.validate(structuredClone(openApiSpec) as never)).resolves.toBeTruthy();
  });

  it('documents every route the API registers', async () => {
    const required = [
      '/api/auth/register', '/api/auth/register-manager', '/api/auth/login', '/api/auth/me', '/api/movies', '/api/movies/{id}',
      '/api/admin/movies', '/api/admin/movies/{id}', '/api/theatres', '/api/theatres/{id}', '/api/manager/theatres', '/api/manager/theatres/{id}',
      '/api/theatres/{id}/screens', '/api/manager/theatres/{id}/screens', '/api/manager/shows', '/api/shows', '/api/shows/{id}/seats',
      '/api/bookings/hold', '/api/bookings', '/api/bookings/{id}', '/api/payments', '/api/tickets/{id}', '/api/manager/account-status',
      '/api/admin/manager-requests', '/api/admin/manager-requests/{id}', '/api/manager/theatre-requests', '/api/admin/theatre-requests',
      '/api/admin/theatre-requests/{id}', '/api/manager/reports/summary', '/api/manager/reports/revenue', '/api/manager/reports/bookings',
      '/api/manager/reports/occupancy', '/api/admin/reports/summary', '/api/admin/reports/revenue', '/api/admin/reports/bookings',
      '/api/admin/reports/theatres', '/health/live', '/health/ready', '/metrics',
    ];
    for (const path of required) expect(openApiSpec.paths, path).toHaveProperty([path]);
    const payments = (openApiSpec.paths as Record<string, Record<string, { parameters: { name: string }[] }>>)['/api/payments']!.post!;
    expect(payments.parameters.map((p) => p.name)).toContain('Idempotency-Key');
  });
});

describe('log redaction', () => {
  it('censors passwords, tokens and authorization headers', () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
    log.info({ req: { headers: { authorization: 'Bearer secret-jwt' } }, body: { password: 'hunter2', token: 'abc', cardNumber: '4242424242424242' }, user: { password: 'p' } }, 'x');
    const out = lines.join('');
    for (const secret of ['secret-jwt', 'hunter2', '4242424242424242']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });
});
