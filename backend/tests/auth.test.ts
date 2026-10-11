import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import { execute, selectOne } from '../src/shared/database/sequelize';
import { auth, buildApp, createUser, PASSWORD, resetData } from './helpers';

const { app } = buildApp();

const registration = (over: Record<string, unknown> = {}) => ({
  name: 'Jane Viewer',
  email: 'jane@example.com',
  password: PASSWORD,
  confirmPassword: PASSWORD,
  ...over,
});

beforeEach(resetData);

describe('registration', () => {
  it('registers a customer who is ACTIVE immediately', async () => {
    const res = await request(app).post('/api/auth/register').send(registration());
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role: 'CUSTOMER', accountStatus: 'ACTIVE' });
    expect(res.body.data.token).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|passwordHash/);
  });

  it('registers a manager as PENDING_APPROVAL', async () => {
    const res = await request(app).post('/api/auth/register-manager').send(registration({ email: 'm@example.com' }));
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role: 'THEATRE_MANAGER', accountStatus: 'PENDING_APPROVAL' });
  });

  it('rejects a duplicate email regardless of case', async () => {
    await request(app).post('/api/auth/register').send(registration());
    const res = await request(app).post('/api/auth/register').send(registration({ email: 'JANE@example.com' }));
    expect(res.status).toBe(409);
  });

  it('refuses to create ADMIN accounts through any public endpoint', async () => {
    for (const path of ['/api/auth/register', '/api/auth/register-manager']) {
      const res = await request(app).post(path).send(registration({ email: 'evil@example.com', role: 'ADMIN' }));
      expect(res.status).toBe(422);
    }
    const count = await request(app).post('/api/auth/login').send({ email: 'evil@example.com', password: PASSWORD });
    expect(count.status).toBe(401);
  });

  it('validates password strength and confirmation', async () => {
    expect((await request(app).post('/api/auth/register').send(registration({ password: 'short', confirmPassword: 'short' }))).status).toBe(422);
    expect((await request(app).post('/api/auth/register').send(registration({ confirmPassword: 'Different1!' }))).status).toBe(422);
  });
});

describe('login and sessions', () => {
  it('logs in with the right password and rejects the wrong one', async () => {
    await request(app).post('/api/auth/register').send(registration());
    const ok = await request(app).post('/api/auth/login').send({ email: 'jane@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ email: 'jane@example.com', password: 'WrongPass1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Incorrect email or password');
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    expect(unknown.body.error.message).toBe(bad.body.error.message);
  });

  it('lets a pending manager log in and see status, without creating duplicate state', async () => {
    await request(app).post('/api/auth/register-manager').send(registration({ email: 'm@example.com' }));
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/auth/login').send({ email: 'm@example.com', password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.data.user.accountStatus).toBe('PENDING_APPROVAL');
    }
    const audit = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM approval_audit_logs', []);
    expect(audit?.n).toBe(0);
  });

  it('denies login for suspended users', async () => {
    const user = await createUser('CUSTOMER', 'SUSPENDED', 'sus@example.com');
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('a JWT issued before suspension stops working immediately', async () => {
    const user = await createUser('CUSTOMER');
    expect((await request(app).get('/api/auth/me').set(auth(user))).status).toBe(200);
    await execute("UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1", [user.id]);
    const res = await request(app).get('/api/auth/me').set(auth(user));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('rejects missing, malformed, expired and wrongly-signed tokens', async () => {
    const user = await createUser('CUSTOMER');
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
    const expired = jwt.sign({ sub: user.id, role: 'CUSTOMER' }, process.env.JWT_SECRET!, { expiresIn: -10 });
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
    const forged = jwt.sign({ sub: user.id, role: 'ADMIN' }, 'some-other-secret-value-1234');
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('ignores a role claim in the token: current database role wins', async () => {
    const customer = await createUser('CUSTOMER');
    const escalated = jwt.sign({ sub: customer.id, role: 'ADMIN' }, process.env.JWT_SECRET!);
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${escalated}`);
    expect(res.status).toBe(403);
  });
});
