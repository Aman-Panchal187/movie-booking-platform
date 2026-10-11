import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { execute, selectOne } from '../src/shared/database/sequelize';
import { auth, buildApp, createMovie, createUser, createVenue, PASSWORD, resetData, TestUser } from './helpers';

const { app } = buildApp();
let admin: TestUser;

const theatreBody = (name = 'Grand Cinema') => ({
  name, city: 'Pune', address: '42 Film Road, Pune', contactNumber: '+91 20 5555 1234',
});

async function registerManager(email: string) {
  const res = await request(app).post('/api/auth/register-manager').send({ name: 'Mo Manager', email, password: PASSWORD, confirmPassword: PASSWORD });
  return { id: res.body.data.user.id as string, token: res.body.data.token as string, email, role: 'THEATRE_MANAGER' as const };
}

const decideManager = (id: string, action: string, reason?: string) =>
  request(app).patch(`/api/admin/manager-requests/${id}`).set(auth(admin)).send({ action, reason });
const decideTheatre = (id: string, action: string, reason?: string) =>
  request(app).patch(`/api/admin/theatre-requests/${id}`).set(auth(admin)).send({ action, reason });

beforeEach(async () => {
  await resetData();
  admin = await createUser('ADMIN');
});

describe('Level 1: manager account approval', () => {
  it('a pending manager cannot use management endpoints but can read their status', async () => {
    const m = await registerManager('pending@example.com');
    expect((await request(app).get('/api/manager/theatres').set(auth(m))).status).toBe(403);
    expect((await request(app).post('/api/manager/theatres').set(auth(m)).send(theatreBody())).status).toBe(403);
    const status = await request(app).get('/api/manager/account-status').set(auth(m));
    expect(status.status).toBe(200);
    expect(status.body.data.accountStatus).toBe('PENDING_APPROVAL');
  });

  it('admin approves a manager, who then reaches the dashboard', async () => {
    const m = await registerManager('approve@example.com');
    const res = await decideManager(m.id, 'APPROVE');
    expect(res.status).toBe(200);
    expect(res.body.data.manager.accountStatus).toBe('ACTIVE');
    expect((await request(app).get('/api/manager/theatres').set(auth(m))).status).toBe(200);
  });

  it('admin rejects with a reason (required), shown to the manager', async () => {
    const m = await registerManager('reject@example.com');
    expect((await decideManager(m.id, 'REJECT')).status).toBe(422);
    expect((await decideManager(m.id, 'REJECT', 'Incomplete business details')).status).toBe(200);
    const status = await request(app).get('/api/manager/account-status').set(auth(m));
    expect(status.body.data).toMatchObject({ accountStatus: 'REJECTED', rejectionReason: 'Incomplete business details' });
    expect((await request(app).get('/api/manager/theatres').set(auth(m))).status).toBe(403);
  });

  it('managers cannot approve themselves or anyone else', async () => {
    const m = await registerManager('self@example.com');
    const res = await request(app).patch(`/api/admin/manager-requests/${m.id}`).set(auth(m)).send({ action: 'APPROVE' });
    expect(res.status).toBe(403);
  });

  it('concurrent duplicate approvals are safe and idempotent, with one audit row', async () => {
    const m = await registerManager('dup@example.com');
    const results = await Promise.all(Array.from({ length: 10 }, () => decideManager(m.id, 'APPROVE')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.data.changed)).toHaveLength(1);
    const audit = await selectOne<{ n: number }>("SELECT COUNT(*) AS n FROM approval_audit_logs WHERE entity_id = $1 AND action = 'MANAGER_APPROVE'", [m.id]);
    expect(audit?.n).toBe(1);
  });

  it('conflicting concurrent decisions leave exactly one winner', async () => {
    const m = await registerManager('conflict@example.com');
    const [a, b] = await Promise.all([decideManager(m.id, 'APPROVE'), decideManager(m.id, 'REJECT', 'Not suitable')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('a suspended manager is locked out even with an older JWT', async () => {
    const m = await registerManager('susp@example.com');
    await decideManager(m.id, 'APPROVE');
    expect((await request(app).get('/api/manager/theatres').set(auth(m))).status).toBe(200);
    expect((await decideManager(m.id, 'SUSPEND', 'Policy breach')).status).toBe(200);
    const res = await request(app).get('/api/manager/theatres').set(auth(m));
    expect(res.status).toBe(403);
  });
});

describe('Level 2: theatre approval', () => {
  async function approvedManager(email = 'tm@example.com') {
    const m = await registerManager(email);
    await decideManager(m.id, 'APPROVE');
    return m;
  }

  it('theatre starts pending, is invisible publicly, then visible after approval with an assignment', async () => {
    const m = await approvedManager();
    const created = await request(app).post('/api/manager/theatres').set(auth(m)).send(theatreBody());
    expect(created.status).toBe(201);
    const theatreId = created.body.data.id as string;
    expect(created.body.data.approvalStatus).toBe('PENDING_APPROVAL');

    const publicList = await request(app).get('/api/theatres');
    expect(publicList.body.data.find((t: { id: string }) => t.id === theatreId)).toBeUndefined();
    expect((await request(app).get(`/api/theatres/${theatreId}`)).status).toBe(404);

    // Pending theatres cannot be configured yet.
    const early = await request(app).post(`/api/manager/theatres/${theatreId}/screens`).set(auth(m)).send({ name: 'S1', rows: 3, seatsPerRow: 4 });
    expect(early.status).toBe(403);

    expect((await decideTheatre(theatreId, 'APPROVE')).status).toBe(200);
    expect((await request(app).get('/api/theatres')).body.data.some((t: { id: string }) => t.id === theatreId)).toBe(true);
    const assignment = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM theatre_manager_assignments WHERE manager_id = $1 AND theatre_id = $2', [m.id, theatreId]);
    expect(assignment?.n).toBe(1);

    const screen = await request(app).post(`/api/manager/theatres/${theatreId}/screens`).set(auth(m)).send({ name: 'S1', rows: 3, seatsPerRow: 4, premiumRows: 1 });
    expect(screen.status).toBe(201);
  });

  it('admin rejects with a reason; manager sees it and can revise and resubmit', async () => {
    const m = await approvedManager();
    const theatreId = (await request(app).post('/api/manager/theatres').set(auth(m)).send(theatreBody())).body.data.id as string;
    expect((await decideTheatre(theatreId, 'REJECT')).status).toBe(422);
    expect((await decideTheatre(theatreId, 'REJECT', 'Address could not be verified')).status).toBe(200);

    const requests = await request(app).get('/api/manager/theatre-requests').set(auth(m));
    expect(requests.body.data[0]).toMatchObject({ approvalStatus: 'REJECTED', rejectionReason: 'Address could not be verified' });
    expect((await request(app).get(`/api/theatres/${theatreId}`)).status).toBe(404);

    const revised = await request(app).patch(`/api/manager/theatres/${theatreId}`).set(auth(m)).send({ address: '42 Film Road, Pune 411001' });
    expect(revised.status).toBe(200);
    expect(revised.body.data.approvalStatus).toBe('PENDING_APPROVAL');
    expect((await decideTheatre(theatreId, 'APPROVE')).status).toBe(200);
  });

  it('one manager can run many theatres; a new pending one does not disturb approved ones', async () => {
    const m = await approvedManager();
    const ids: string[] = [];
    for (const n of ['Alpha', 'Beta', 'Gamma']) {
      ids.push((await request(app).post('/api/manager/theatres').set(auth(m)).send(theatreBody(n))).body.data.id);
    }
    await decideTheatre(ids[0]!, 'APPROVE');
    await decideTheatre(ids[1]!, 'APPROVE');
    const list = await request(app).get('/api/manager/theatres').set(auth(m));
    const byId = Object.fromEntries(list.body.data.map((t: { id: string; approvalStatus: string }) => [t.id, t.approvalStatus]));
    expect(byId).toEqual({ [ids[0]!]: 'APPROVED', [ids[1]!]: 'APPROVED', [ids[2]!]: 'PENDING_APPROVAL' });
    const publicIds = (await request(app).get('/api/theatres')).body.data.map((t: { id: string }) => t.id);
    expect(publicIds).toEqual(expect.arrayContaining([ids[0], ids[1]]));
    expect(publicIds).not.toContain(ids[2]);
  });

  it('a manager cannot read or modify another manager\'s theatre', async () => {
    const a = await approvedManager('a@example.com');
    const b = await approvedManager('b@example.com');
    const theatreId = (await request(app).post('/api/manager/theatres').set(auth(a)).send(theatreBody())).body.data.id as string;
    await decideTheatre(theatreId, 'APPROVE');
    expect((await request(app).get(`/api/manager/theatres/${theatreId}`).set(auth(b))).status).toBe(403);
    expect((await request(app).patch(`/api/manager/theatres/${theatreId}`).set(auth(b)).send({ name: 'Hijacked' })).status).toBe(404);
    expect((await request(app).post(`/api/manager/theatres/${theatreId}/screens`).set(auth(b)).send({ name: 'S9', rows: 2, seatsPerRow: 2 })).status).toBe(403);
    const movieId = await createMovie();
    const screenId = (await request(app).post(`/api/manager/theatres/${theatreId}/screens`).set(auth(a)).send({ name: 'S1', rows: 2, seatsPerRow: 3 })).body.data.id;
    const show = await request(app).post('/api/manager/shows').set(auth(b)).send({
      movieId, screenId, startTime: new Date(Date.now() + 86_400_000).toISOString(), prices: { STANDARD: 1000, PREMIUM: 2000, RECLINER: 3000 },
    });
    expect(show.status).toBe(403);
  });

  it('revoking an assignment removes access immediately without deleting the theatre; extra managers can be assigned', async () => {
    const a = await approvedManager('a2@example.com');
    const b = await approvedManager('b2@example.com');
    const theatreId = (await request(app).post('/api/manager/theatres').set(auth(a)).send(theatreBody())).body.data.id as string;
    await decideTheatre(theatreId, 'APPROVE');

    expect((await request(app).post(`/api/admin/theatres/${theatreId}/managers`).set(auth(admin)).send({ managerId: b.id })).status).toBe(201);
    expect((await request(app).get(`/api/manager/theatres/${theatreId}`).set(auth(b))).status).toBe(200);

    expect((await request(app).delete(`/api/admin/theatres/${theatreId}/managers/${b.id}`).set(auth(admin))).status).toBe(200);
    expect((await request(app).get(`/api/manager/theatres/${theatreId}`).set(auth(b))).status).toBe(403);
    expect((await request(app).get(`/api/theatres/${theatreId}`)).status).toBe(200);
    const dup = await request(app).post(`/api/admin/theatres/${theatreId}/managers`).set(auth(admin)).send({ managerId: a.id });
    expect(dup.status).toBe(201);
    const count = await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM theatre_manager_assignments WHERE theatre_id = $1 AND manager_id = $2', [theatreId, a.id]);
    expect(count?.n).toBe(1);
  });

  it('a suspended theatre disappears from the public catalog and stops accepting holds', async () => {
    const a = await approvedManager('a3@example.com');
    const venue = await createVenue(a);
    expect((await request(app).get(`/api/theatres/${venue.theatreId}`)).status).toBe(200);
    await decideTheatre(venue.theatreId, 'SUSPEND', 'Safety inspection');
    expect((await request(app).get(`/api/theatres/${venue.theatreId}`)).status).toBe(404);
    const customer = await createUser('CUSTOMER');
    const res = await request(app).post('/api/bookings/hold').set(auth(customer)).send({ showId: venue.showId, showSeatIds: [venue.showSeatIds[0]] });
    expect(res.status).toBe(409);
  });

  it('shows on a screen cannot overlap, enforced by PostgreSQL', async () => {
    const a = await approvedManager('a4@example.com');
    const venue = await createVenue(a);
    const start = new Date(Date.now() + 90 * 3_600_000).toISOString();
    const body = { movieId: venue.movieId, screenId: venue.screenId, startTime: start, prices: { STANDARD: 1000, PREMIUM: 2000, RECLINER: 3000 } };
    expect((await request(app).post('/api/manager/shows').set(auth(a)).send(body)).status).toBe(201);
    expect((await request(app).post('/api/manager/shows').set(auth(a)).send(body)).status).toBe(409);
    await expect(
      execute('INSERT INTO shows (movie_id, screen_id, start_time, end_time) VALUES ($1,$2,$3::timestamptz + INTERVAL \'30 minutes\', $3::timestamptz + INTERVAL \'90 minutes\')', [venue.movieId, venue.screenId, start]),
    ).rejects.toThrow();
  });

  it('records every admin decision in the audit log', async () => {
    const m = await approvedManager('audit@example.com');
    const theatreId = (await request(app).post('/api/manager/theatres').set(auth(m)).send(theatreBody())).body.data.id as string;
    await decideTheatre(theatreId, 'REJECT', 'Duplicate listing');
    const logs = await request(app).get('/api/admin/audit-logs').set(auth(admin));
    const actions = logs.body.data.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['MANAGER_APPROVE', 'SUBMITTED', 'THEATRE_REJECT']));
    expect((await request(app).get('/api/admin/audit-logs').set(auth(m))).status).toBe(403);
  });

  it('admin user listings never expose password hashes', async () => {
    await registerManager('leakcheck@example.com');
    const res = await request(app).get('/api/admin/users').set(auth(admin));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });
});
