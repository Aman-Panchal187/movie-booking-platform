import pino, { Logger } from 'pino';
import { env } from '../config/env';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.password',
  '*.confirmPassword',
  '*.password_hash',
  '*.passwordHash',
  '*.token',
  '*.cardNumber',
  '*.cvv',
  'password',
  'token',
  'authorization',
];

export const logger: Logger = pino({
  level: env().LOG_LEVEL,
  base: { service: 'movie-booking-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
});

export function moduleLogger(module: string): Logger {
  return logger.child({ module });
}
