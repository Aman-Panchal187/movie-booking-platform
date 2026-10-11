// Seat-hold contention against the LOCAL docker stack (never run this against free public hosting).
//   docker compose up --build -d
//   k6 run -e BASE=http://localhost:8080 -e DEMO_PASSWORD=<your DEMO_PASSWORD> tests/k6/hold-contention.js
//
// 50 virtual users register, then all try to hold the SAME seat at the same moment.
// Pass criteria: exactly one 201, every other attempt 409 (no 5xx, no double-hold).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:8080';
const won = new Counter('holds_won');
const lost = new Counter('holds_conflict');
const errors = new Counter('holds_unexpected');

export const options = {
  scenarios: {
    contention: { executor: 'per-vu-iterations', vus: 50, iterations: 1, maxDuration: '2m' },
  },
  thresholds: {
    holds_won: ['count==1'],
    holds_unexpected: ['count==0'],
  },
};

const json = { headers: { 'Content-Type': 'application/json' } };

export function setup() {
  const shows = http.get(`${BASE}/api/shows`).json('data');
  const show = shows.find((s) => s.availableSeats > 5);
  const seat = http.get(`${BASE}/api/shows/${show.id}/seats`).json('data.seats').find((s) => s.status === 'AVAILABLE');
  return { showId: show.id, seatId: seat.showSeatId };
}

export default function (data) {
  const email = `k6+${__VU}-${Date.now()}@load.test`;
  const reg = http.post(`${BASE}/api/auth/register`, JSON.stringify({ name: `K6 User ${__VU}`, email, password: 'LoadTest123', confirmPassword: 'LoadTest123' }), json);
  const token = reg.json('data.token');
  const res = http.post(`${BASE}/api/bookings/hold`, JSON.stringify({ showId: data.showId, showSeatIds: [data.seatId] }), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  check(res, { 'status is 201 or 409': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 201) won.add(1);
  else if (res.status === 409) lost.add(1);
  else errors.add(1);
}
