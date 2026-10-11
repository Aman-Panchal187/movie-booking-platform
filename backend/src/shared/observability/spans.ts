import { SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('movie-booking-api');

/** Runs fn inside an active span; a no-op tracer is used when tracing is disabled. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : 'error' });
      throw err;
    } finally {
      span.end();
    }
  });
}
