import { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from './errors';
import { logger } from '../logging/logger';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
};

interface BodyParserError {
  type?: string;
  status?: number;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: req.id },
    });
  }

  const parser = err as BodyParserError;
  if (parser?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', requestId: req.id } });
  }
  if (parser?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body', requestId: req.id } });
  }

  logger.error({ err, requestId: req.id, method: req.method, url: req.originalUrl }, 'unhandled error');
  return res
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId: req.id } });
};
