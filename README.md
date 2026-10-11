# CineBook — Movie Ticket Booking Platform

Full-stack MVP: customers browse movies, pick seats on a live seat map, pay with a **mock** payment and get a ticket; theatre managers register theatres (two-level admin approval), configure screens/shows and see reports; admins approve, manage and analyse the platform.

**Modular monolith**: one Express API (TypeScript, strict) + one PostgreSQL database, fronted by Nginx; React/Vite SPA.

## Status — what is verified and what is not

| Area | Status |
|---|---|
| Backend (auth, catalog, booking, payments, approvals, reports, media, audit) | Implemented; **81 backend tests pass** against real PostgreSQL |
| Frontend (customer, manager, admin portals, charts) | Implemented; **18 component tests pass**; production build OK |
| Playwright E2E (customer, manager→admin approval chain, admin) | **3/3 pass** locally against the full stack |
| Docker Compose (nginx + express + postgres + redis), production `edge` image | Built and run locally; k6 contention test passed |
| OpenAPI 3.0 + Swagger UI (`/api-docs`) | Implemented, validated in tests and CI (49 paths) |
| Prometheus/Grafana/Jaeger compose profile | Config provided; **not exercised** in this session |
| **Public deployment (Neon, Render, Vercel)** | **NOT done** — needs your accounts/credentials. Steps below. No public URLs exist yet. |
| Upstash Redis, Cloudinary | Code implemented. Redis TCP verified locally; **Upstash REST and Cloudinary were never run against the real services** |
| GitHub Actions CI | Workflow written; **never executed** (no repository) |

## Quick start (local)

```bash
cp .env.example .env            # optional; compose has safe local defaults
DEMO_PASSWORD='choose-a-local-password' docker compose up --build
# app API via nginx: http://localhost:8080   Swagger: http://localhost:8080/api-docs
```
The `migrate` service applies migrations and seeds demo data (idempotent). With `DEMO_PASSWORD` set it also creates **local-only** accounts: `admin@demo.local`, `manager@demo.local`, `customer@demo.local`, `pending.manager@demo.local` (all with that password). This is refused when `NODE_ENV=production`.

Frontend dev server: `npm ci && npm run dev:frontend` (proxies `/api` to `localhost:3000`; set `VITE_PROXY_TARGET=http://localhost:8080` to use the compose stack).

Without Docker: run PostgreSQL yourself, set `DATABASE_URL`/`JWT_SECRET`, then `npm run migrate:dev -w backend && npm run seed:dev -w backend && npm run dev:backend`.

Observability: `docker compose --profile observability up` → Prometheus :9090, Grafana :3001 (provisioned "Movie Booking API" dashboard), Jaeger :16686 (set `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318` on the backend).

Clean rebuild: `docker compose down -v && docker compose up --build`.

## Tests

```bash
npm run test -w backend      # needs PostgreSQL; TEST_DATABASE_URL defaults to localhost:55432/mbp_test
npm run test -w frontend
npm run test:e2e             # needs PostgreSQL on localhost:55432 (db mbp_e2e); starts API + Vite itself
# k6 (against the local docker stack only, never public hosting):
docker compose up -d && RELAX_RATE_LIMITS=true docker compose up -d backend
docker run --rm --network movie-booking_internal -v "$PWD/tests/k6:/k6" grafana/k6 run -e BASE=http://backend:3000 /k6/hold-contention.js
```
Backend tests recreate the schema from the real migrations; concurrency tests use real PostgreSQL (no SQLite, no mocked locks). Includes: 100 concurrent holds → exactly one winner; opposite-order multi-seat requests (no deadlock); concurrent duplicate payments → one payment/ticket; hold-expiry vs payment race; concurrent duplicate approvals.

## Architecture

```
Browser ──► Vercel (React SPA) ──► Render: [ Nginx :$PORT ──► Express 127.0.0.1:3000 ] ──► Neon PostgreSQL
                                                                      └──► Upstash Redis (cache + rate-limit counters)
                                                                      └──► Cloudinary (poster/banner uploads)
```
- `backend/src/modules/*`: auth, users, movies, theatres (+screens), shows, bookings (+tickets), payments, manager-approvals, theatre-approvals, reports, media, audit, admin (route composition). Shared: config, database, middleware, errors, logging, cache, observability.
- Migrations are plain versioned SQL (`backend/src/shared/database/migrations`) applied by a locked runner (`schema_migrations`); no `sync()`. Sequelize provides the connection/pool/transactions; booking-critical statements are explicit parameterized SQL.
- Money is integer paise; shown as INR. Report days are IST (`Asia/Kolkata`).

### Booking correctness (PostgreSQL is authoritative)
- `UNIQUE(show_id, seat_id)` plus a CHECK tying seat status to `booking_id`.
- Hold = one transaction: lock requested `show_seats` rows `ORDER BY id FOR UPDATE`, verify all are available (or expired), insert booking, claim seats. Any unavailable seat → rollback → **409**. Fixed lock order prevents deadlocks.
- Expiry uses the database clock (`clock_timestamp()` inside transactions, because `NOW()` is the transaction start and can lag behind lock waits). Expired holds are reclaimed **lazily** — no timers/cron, so they work after a Render cold start. Redis is never involved in seat state.
- Show overlap is prevented by a `btree_gist` exclusion constraint.

### Mock payments & idempotency
`POST /api/payments` requires `Idempotency-Key`. `payments(user_id, idempotency_key)` is unique; same key + same payload replays the stored result (`Idempotent-Replayed: true`), same key + different payload → 409. Lock order is booking row → payment row → seat rows (locking the booking first matters: the payments FK would otherwise take a conflicting `KEY SHARE` lock and deadlock concurrent attempts — found and fixed by the concurrency tests). Success path (payment, seats `BOOKED`, booking `CONFIRMED`, ticket) is one transaction; a decline persists a `FAILED` payment and leaves the hold intact. Card numbers ending `0002` are declined; full card numbers are never stored or logged.

`PAYMENT_PROCESSING` and `bookings.payment_processing_expires_at` exist in the schema but are **unused**: the mock settles synchronously inside one transaction. A real gateway would need provider-side idempotency keys, webhooks, a reconciliation job for stuck `PAYMENT_PROCESSING` bookings, and refund/compensation flows — deliberately not simulated here.

### Approvals
Managers register as `PENDING_APPROVAL`; the admin approves/rejects (reason required to reject)/suspends. Account status is re-read from the DB on **every** request, so a suspended user's old JWT stops working immediately. Active managers submit theatres (`PENDING_APPROVAL`, invisible publicly); approval creates the `theatre_manager_assignments` row. Decisions are row-locked, idempotent (repeat = no-op) and audited in the same transaction. Every manager operation re-checks assignment + approved status in the DB. Rejected theatres can be edited and resubmitted.

### Security
Helmet, strict CORS allow-list, Zod validation (`.strict()` schemas — extra fields such as `role` are rejected, so no public admin creation), bcrypt, rate limits (Nginx coarse + `express-rate-limit`; Redis-backed when configured, **falls back to per-process counters if Redis errors** — degraded, not open), `trust proxy` = 1 hop because Nginx overwrites `X-Forwarded-For`. `/metrics` is 404 through Nginx and needs a bearer `METRICS_TOKEN` (or is disabled) in production. JWT is kept in `localStorage` (simple; XSS-exposed — an httpOnly-cookie session would be stronger and is the first hardening step).

Bootstrap the first admin (no public endpoint, no default password):
`ADMIN_EMAIL=you@x.com ADMIN_NAME="You" ADMIN_PASSWORD='<12+ chars>' npm run admin:create -w backend` (on Render: use the Shell with the variables set there, or run locally against the Neon `DATABASE_URL`).

## Deployment (manual — requires your accounts)

1. **Neon**: create a project → copy the pooled connection string (`...?sslmode=require`).
2. **Render**: New → Blueprint → select this repo (`render.yaml`). Free plan, Docker target `edge`. Set `DATABASE_URL`, `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS` (your Vercel URL) and optionally `UPSTASH_REDIS_REST_URL/TOKEN`, `CLOUDINARY_*`. `JWT_SECRET`/`METRICS_TOKEN` are generated. The container runs migrations on start. Keep `DB_POOL_MAX` small (5).
3. **Seed catalog** (once; safe to repeat): from your machine `DATABASE_URL=<neon> NODE_ENV=production npm run build -w backend && node backend/dist/scripts/seed.js` — in production this creates only synthetic catalog data and unusable-password demo accounts, never known credentials.
4. **Admin**: run `admin:create` as above.
5. **Vercel**: import repo, root directory `frontend`, env `VITE_API_BASE_URL=https://<service>.onrender.com`. `frontend/vercel.json` provides SPA rewrites.
6. **Verify**: `GET /health/ready`, `/api-docs`, register → book → refresh ticket page; check Render logs.
7. Optional: connect the repo for Render/Vercel Git deploys; add the CI workflow's required checks.

Free-tier notes: Render suspends idle services; the SPA shows a "waking up" banner after 3 s, retries only safe GETs (never payments), and the payment `Idempotency-Key` is reused on a network failure and replaced only after a definitive server response. There is no keep-alive pinging. Only structured Render logs and health checks exist in the cloud; no metrics retention, traces, or alerting unless you configure an external OTLP collector.

## Environment variables
See [.env.example](.env.example). Validated at startup (`backend/src/shared/config/env.ts`); Redis/Cloudinary/OTLP are optional and degrade gracefully.

## Known limitations / not done
- Not deployed; public URLs and cloud verification outstanding (see above).
- Manager show editing is limited to create/cancel (cancel only with no held/confirmed bookings); no repricing, screen edits or cancellation/refund workflow for sold shows — intentionally safe over incomplete.
- Cloudinary upload, Upstash REST, OTLP export and the Prometheus/Grafana/Jaeger stack are untested against real endpoints.
- Seed trailers are Blender open-movie YouTube embeds and posters are picsum placeholder photos (not real movie artwork); they require outbound internet.
- Seat-map availability refreshes by polling (15 s), not push.
- Frontend tests cover components/guards/forms; checkout and manager forms are exercised by Playwright rather than unit tests.
- JWT in localStorage; no refresh tokens or password reset/email verification.
