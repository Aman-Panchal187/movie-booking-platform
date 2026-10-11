import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const bookingConflicts = new client.Counter({
  name: 'booking_conflicts_total',
  help: 'Seat hold attempts rejected because seats were unavailable',
  registers: [registry],
});

export const seatHolds = new client.Counter({
  name: 'seat_holds_total',
  help: 'Successful seat holds',
  registers: [registry],
});

export const bookingsConfirmed = new client.Counter({
  name: 'bookings_confirmed_total',
  help: 'Bookings confirmed by successful mock payment',
  registers: [registry],
});

export const paymentsTotal = new client.Counter({
  name: 'mock_payments_total',
  help: 'Mock payment outcomes',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const paymentReplays = new client.Counter({
  name: 'payment_idempotent_replays_total',
  help: 'Payment requests answered from an existing idempotency record',
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: 'cache_events_total',
  help: 'Cache hits, misses and errors',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const dbFailures = new client.Counter({
  name: 'postgres_connectivity_failures_total',
  help: 'Failed PostgreSQL connectivity checks',
  registers: [registry],
});
