export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'ACCOUNT_SUSPENDED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SEATS_UNAVAILABLE'
  | 'HOLD_EXPIRED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'PAYMENT_DECLINED'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, 'VALIDATION_ERROR', m, d);
export const unauthorized = (m = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', m);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (m: string, d?: unknown) => new AppError(409, 'CONFLICT', m, d);
