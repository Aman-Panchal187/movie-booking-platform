/* OpenAPI 3.0 description of every implemented route. Validated in CI by scripts/validate-openapi.ts. */

type Json = Record<string, unknown>;
type Role = 'public' | 'CUSTOMER' | 'THEATRE_MANAGER' | 'ADMIN';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorRef = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});

interface Op {
  tag: string;
  summary: string;
  role: Role | Role[];
  body?: Json;
  query?: string[];
  params?: string[];
  idempotency?: boolean;
  example?: Json;
  success?: number;
  multipart?: boolean;
}

const PAGINATION = ['page', 'pageSize'];

function param(name: string, where: 'query' | 'path'): Json {
  const isPage = name === 'page' || name === 'pageSize';
  return {
    name,
    in: where,
    required: where === 'path',
    schema: isPage ? { type: 'integer', minimum: 1, default: name === 'page' ? 1 : 20 } : { type: 'string' },
  };
}

function op(o: Op): Json {
  const roles = Array.isArray(o.role) ? o.role : [o.role];
  const isPublic = roles.includes('public');
  const parameters: Json[] = [
    ...(o.params ?? []).map((p) => param(p, 'path')),
    ...(o.query ?? []).map((p) => param(p, 'query')),
  ];
  if (o.idempotency) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: 'Unique key (8-128 URL-safe chars). Same key + same body replays the original result; same key + different body returns 409.',
      schema: { type: 'string', minLength: 8, maxLength: 128 },
    });
  }
  const status = String(o.success ?? 200);
  const responses: Record<string, Json> = {
    [status]: {
      description: 'Success',
      content: { 'application/json': { schema: { type: 'object', properties: { data: {}, meta: ref('PageMeta') } }, ...(o.example ? { example: o.example } : {}) } },
    },
    '422': errorRef('Validation failed'),
    '429': { ...errorRef('Rate limited'), headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait' } } },
  };
  if (!isPublic) {
    responses['401'] = errorRef('Missing or invalid token');
    responses['403'] = errorRef(`Requires role: ${roles.join(' or ')}`);
  }
  if ((o.params ?? []).length > 0) responses['404'] = errorRef('Not found');
  if (o.body || o.idempotency) responses['409'] = errorRef('Conflict (seats unavailable, state transition, idempotency mismatch)');
  return {
    tags: [o.tag],
    summary: o.summary,
    description: `Access: ${roles.join(', ')}`,
    ...(isPublic ? {} : { security: [{ bearerAuth: [] }] }),
    parameters,
    ...(o.body
      ? { requestBody: { required: true, content: { [o.multipart ? 'multipart/form-data' : 'application/json']: { schema: o.body } } } }
      : {}),
    responses,
  };
}

const str = { type: 'string' };
const uuid = { type: 'string', format: 'uuid' };
const int = { type: 'integer' };
const obj = (properties: Json, required: string[] = []): Json => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const paths: Record<string, Record<string, Json>> = {};
const add = (method: 'get' | 'post' | 'patch' | 'delete', path: string, o: Op) => {
  paths[path] = { ...(paths[path] ?? {}), [method]: op(o) };
};

const registerBody = obj(
  { name: str, email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 }, confirmPassword: str },
  ['name', 'email', 'password', 'confirmPassword'],
);
const reportQuery = ['range', 'from', 'to', 'theatreId', ...PAGINATION];
const movieBodySchema = obj(
  { title: str, description: str, language: str, genre: str, durationMinutes: int, releaseDate: str, certification: str, posterUrl: str, bannerUrl: str, trailerUrl: str, isActive: { type: 'boolean' } },
  ['title', 'language', 'genre', 'durationMinutes'],
);

// Authentication
add('post', '/api/auth/register', { tag: 'Authentication', summary: 'Register a customer (ACTIVE immediately)', role: 'public', body: registerBody, success: 201 });
add('post', '/api/auth/register-manager', { tag: 'Authentication', summary: 'Register a theatre manager (PENDING_APPROVAL)', role: 'public', body: registerBody, success: 201 });
add('post', '/api/auth/login', { tag: 'Authentication', summary: 'Log in and receive a JWT', role: 'public', body: obj({ email: str, password: str }, ['email', 'password']) });
add('get', '/api/auth/me', { tag: 'Authentication', summary: 'Current user and account status', role: ['CUSTOMER', 'THEATRE_MANAGER', 'ADMIN'] });

// Catalog
add('get', '/api/movies', { tag: 'Movies', summary: 'List active movies (cached 5 min)', role: 'public', query: ['q', 'genre', 'language', 'city'] });
add('get', '/api/movies/{id}', { tag: 'Movies', summary: 'Movie details (cached 10 min)', role: 'public', params: ['id'] });
add('get', '/api/theatres', { tag: 'Theatres', summary: 'List APPROVED theatres only', role: 'public', query: ['city'] });
add('get', '/api/theatres/{id}', { tag: 'Theatres', summary: 'Approved theatre details', role: 'public', params: ['id'] });
add('get', '/api/theatres/{id}/screens', { tag: 'Screens', summary: 'Screens of an approved theatre', role: 'public', params: ['id'] });
add('get', '/api/shows', { tag: 'Shows', summary: 'Upcoming shows (cached 60 s)', role: 'public', query: ['movieId', 'theatreId', 'city', 'date'] });
add('get', '/api/shows/{id}/seats', { tag: 'Seats', summary: 'Authoritative seat map from PostgreSQL (never cached)', role: 'public', params: ['id'] });

// Booking and payment
add('post', '/api/bookings/hold', {
  tag: 'Bookings', summary: 'Atomically hold seats (all-or-nothing). 409 if any seat is taken.', role: 'CUSTOMER', success: 201,
  body: obj({ showId: uuid, showSeatIds: { type: 'array', items: uuid, minItems: 1, maxItems: 20 } }, ['showId', 'showSeatIds']),
});
add('get', '/api/bookings', { tag: 'Bookings', summary: 'My bookings', role: ['CUSTOMER', 'ADMIN'], query: PAGINATION });
add('get', '/api/bookings/{id}', { tag: 'Bookings', summary: 'Booking detail (owner or admin)', role: ['CUSTOMER', 'ADMIN'], params: ['id'] });
add('post', '/api/payments', {
  tag: 'Payments', summary: 'Mock payment. 201 confirmed + ticket, 402 declined (card ending 0002).', role: 'CUSTOMER', idempotency: true, success: 201,
  body: obj({ bookingId: uuid, amountMinor: int, cardNumber: str, cardHolder: str }, ['bookingId', 'amountMinor', 'cardNumber', 'cardHolder']),
  example: { data: { status: 'SUCCESS', bookingId: '00000000-0000-0000-0000-000000000000', ticketNumber: 'TKT-ABC123DEF456' } },
});
add('get', '/api/tickets/{id}', { tag: 'Tickets', summary: 'Ticket with booking, show and seats', role: ['CUSTOMER', 'ADMIN'], params: ['id'] });

// Manager
add('get', '/api/manager/account-status', { tag: 'Manager approvals', summary: 'Own approval status (any manager state)', role: 'THEATRE_MANAGER' });
add('get', '/api/manager/theatre-requests', { tag: 'Theatre approvals', summary: 'Theatre applications I submitted', role: 'THEATRE_MANAGER' });
add('get', '/api/manager/theatres', { tag: 'Manager dashboard', summary: 'My theatres in every status', role: 'THEATRE_MANAGER' });
add('post', '/api/manager/theatres', {
  tag: 'Manager dashboard', summary: 'Submit a theatre (PENDING_APPROVAL)', role: 'THEATRE_MANAGER', success: 201,
  body: obj({ name: str, city: str, address: str, contactNumber: str, description: str }, ['name', 'city', 'address', 'contactNumber']),
});
add('get', '/api/manager/theatres/{id}', { tag: 'Manager dashboard', summary: 'Theatre detail (assigned or own submission)', role: 'THEATRE_MANAGER', params: ['id'] });
add('patch', '/api/manager/theatres/{id}', { tag: 'Manager dashboard', summary: 'Edit theatre; editing a REJECTED one resubmits it', role: 'THEATRE_MANAGER', params: ['id'], body: obj({ name: str, city: str, address: str, contactNumber: str, description: str }) });
add('get', '/api/manager/theatres/{id}/screens', { tag: 'Screens', summary: 'Screens of a managed theatre', role: 'THEATRE_MANAGER', params: ['id'] });
add('post', '/api/manager/theatres/{id}/screens', {
  tag: 'Screens', summary: 'Create a screen and generate its seat layout', role: 'THEATRE_MANAGER', params: ['id'], success: 201,
  body: obj({ name: str, rows: int, seatsPerRow: int, premiumRows: int, reclinerRows: int }, ['name', 'rows', 'seatsPerRow']),
});
add('get', '/api/manager/shows', { tag: 'Shows', summary: 'Shows of my theatres with occupancy', role: ['THEATRE_MANAGER', 'ADMIN'], query: ['theatreId', ...PAGINATION] });
add('post', '/api/manager/shows', {
  tag: 'Shows', summary: 'Create a show; overlapping shows on a screen return 409', role: 'THEATRE_MANAGER', success: 201,
  body: obj({ movieId: uuid, screenId: uuid, startTime: { type: 'string', format: 'date-time' }, prices: obj({ STANDARD: int, PREMIUM: int, RECLINER: int }, ['STANDARD', 'PREMIUM', 'RECLINER']) }, ['movieId', 'screenId', 'startTime', 'prices']),
});
add('patch', '/api/manager/shows/{id}/cancel', { tag: 'Shows', summary: 'Cancel a show with no held/confirmed bookings', role: 'THEATRE_MANAGER', params: ['id'] });
for (const [p, summary] of [['summary', 'KPI cards'], ['revenue', 'Daily revenue and booking trend'], ['bookings', 'Booking distribution by movie + paginated sales'], ['occupancy', 'Seat occupancy by show']] as const) {
  add('get', `/api/manager/reports/${p}`, { tag: 'Reports', summary: `Manager report: ${summary} (assigned theatres only)`, role: 'THEATRE_MANAGER', query: reportQuery });
}

// Admin
const decisionBody = (actions: string[]) => obj({ action: { type: 'string', enum: actions }, reason: str }, ['action']);
add('get', '/api/admin/manager-requests', { tag: 'Manager approvals', summary: 'Manager accounts (pending first)', role: 'ADMIN', query: ['status', 'q', ...PAGINATION] });
add('patch', '/api/admin/manager-requests/{id}', { tag: 'Manager approvals', summary: 'Approve / reject / suspend / reactivate (idempotent)', role: 'ADMIN', params: ['id'], body: decisionBody(['APPROVE', 'REJECT', 'SUSPEND', 'REACTIVATE']) });
add('get', '/api/admin/theatre-requests', { tag: 'Theatre approvals', summary: 'All theatres with submitter and managers', role: 'ADMIN', query: ['status', 'q', ...PAGINATION] });
add('patch', '/api/admin/theatre-requests/{id}', { tag: 'Theatre approvals', summary: 'Approve / reject / suspend / reinstate (idempotent)', role: 'ADMIN', params: ['id'], body: decisionBody(['APPROVE', 'REJECT', 'SUSPEND', 'REINSTATE']) });
add('post', '/api/admin/theatres/{id}/managers', { tag: 'Theatre approvals', summary: 'Assign an additional manager', role: 'ADMIN', params: ['id'], success: 201, body: obj({ managerId: uuid }, ['managerId']) });
add('delete', '/api/admin/theatres/{id}/managers/{managerId}', { tag: 'Theatre approvals', summary: 'Revoke a manager assignment', role: 'ADMIN', params: ['id', 'managerId'] });
add('get', '/api/admin/users', { tag: 'Admin dashboard', summary: 'Users (no password hashes)', role: 'ADMIN', query: ['role', 'status', 'q', ...PAGINATION] });
add('patch', '/api/admin/users/{id}/status', { tag: 'Admin dashboard', summary: 'Suspend or reactivate an account', role: 'ADMIN', params: ['id'], body: decisionBody(['SUSPEND', 'REACTIVATE']) });
add('get', '/api/admin/movies', { tag: 'Movies', summary: 'All movies including inactive', role: 'ADMIN', query: ['q', ...PAGINATION] });
add('post', '/api/admin/movies', { tag: 'Movies', summary: 'Create movie', role: 'ADMIN', body: movieBodySchema, success: 201 });
add('patch', '/api/admin/movies/{id}', { tag: 'Movies', summary: 'Edit or deactivate movie', role: 'ADMIN', params: ['id'], body: movieBodySchema });
add('get', '/api/admin/media/status', { tag: 'Media', summary: 'Is Cloudinary configured?', role: 'ADMIN' });
add('post', '/api/admin/media/upload', { tag: 'Media', summary: 'Upload poster/banner to Cloudinary (503 if not configured)', role: 'ADMIN', success: 201, multipart: true, body: obj({ file: { type: 'string', format: 'binary' }, kind: { type: 'string', enum: ['poster', 'banner'] } }, ['file', 'kind']) });
add('get', '/api/admin/bookings', { tag: 'Admin dashboard', summary: 'All bookings', role: 'ADMIN', query: ['status', 'q', ...PAGINATION] });
add('get', '/api/admin/payments', { tag: 'Admin dashboard', summary: 'All payments', role: 'ADMIN', query: ['status', ...PAGINATION] });
add('get', '/api/admin/audit-logs', { tag: 'Admin dashboard', summary: 'Approval audit history', role: 'ADMIN', query: ['entityType', 'q', ...PAGINATION] });
for (const [p, summary] of [['summary', 'Platform KPIs'], ['revenue', 'Revenue and booking trend'], ['bookings', 'Top movies and paginated sales'], ['theatres', 'Top theatres, occupancy, status distributions']] as const) {
  add('get', `/api/admin/reports/${p}`, { tag: 'Reports', summary: `Admin report: ${summary}`, role: 'ADMIN', query: reportQuery });
}

// Operational
paths['/health/live'] = { get: { tags: ['Operational'], summary: 'Liveness', responses: { '200': { description: 'Process is alive' } } } };
paths['/health/ready'] = { get: { tags: ['Operational'], summary: 'Readiness (PostgreSQL required; cache/Cloudinary reported as degraded)', responses: { '200': { description: 'Ready' }, '503': { description: 'Database unavailable' } } } };
paths['/metrics'] = { get: { tags: ['Operational'], summary: 'Prometheus metrics (bearer METRICS_TOKEN; not publicly proxied)', security: [{ metricsToken: [] }], responses: { '200': { description: 'Prometheus text format' }, '401': errorRef('Token required') } } };

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Movie Ticket Booking API',
    version: '1.0.0',
    description:
      'Modular-monolith API. All money is integer minor units (paise, INR). Errors use { error: { code, message, details, requestId } }. Payments are MOCK only.',
  },
  servers: [{ url: '/' }],
  tags: ['Authentication', 'Movies', 'Theatres', 'Screens', 'Shows', 'Seats', 'Bookings', 'Payments', 'Tickets', 'Manager approvals', 'Theatre approvals', 'Manager dashboard', 'Admin dashboard', 'Reports', 'Media', 'Operational'].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      metricsToken: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Error: obj(
        { error: obj({ code: str, message: str, details: {}, requestId: str }, ['code', 'message']) },
        ['error'],
      ),
      PageMeta: obj({ page: int, pageSize: int, total: int, totalPages: int }),
    },
  },
};
