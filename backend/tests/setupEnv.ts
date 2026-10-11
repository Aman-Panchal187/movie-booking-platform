process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/mbp_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.LOG_LEVEL = 'silent';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_POOL_MAX = '25';
process.env.TRUST_PROXY = '1';
delete process.env.REDIS_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
