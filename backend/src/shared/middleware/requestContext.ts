import { randomUUID } from 'node:crypto';
import { RequestHandler } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../logging/logger';
import { httpDuration, httpRequests } from '../observability/metrics';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts the proxy-provided request id (validated) or generates one; echoes it back. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

function routeLabel(req: { baseUrl: string; route?: { path?: string }; path: string }): string {
  return req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
}

export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => req.id,
  customProps: (req) => ({ requestId: req.id }),
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: { ignore: (req) => req.url?.startsWith('/health') === true || req.url === '/metrics' },
});

/** Records Prometheus HTTP metrics using the matched route pattern (low cardinality). */
export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
    httpRequests.inc(labels);
    end(labels);
  });
  next();
};
