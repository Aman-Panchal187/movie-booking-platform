import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { selectOne } from '../database/sequelize';
import { AppError, forbidden, unauthorized } from '../errors/errors';

export type Role = 'CUSTOMER' | 'THEATRE_MANAGER' | 'ADMIN';
export type AccountStatus = 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  accountStatus: AccountStatus;
  rejectionReason: string | null;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

interface TokenPayload {
  sub: string;
  role: Role;
}

export function signToken(user: { id: string; role: Role }): string {
  return jwt.sign({ sub: user.id, role: user.role } satisfies TokenPayload, env().JWT_SECRET, {
    expiresIn: env().JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  account_status: AccountStatus;
  rejection_reason: string | null;
}

/**
 * Verifies the JWT and then reloads the user so role and account status are always the
 * CURRENT database values; a token issued before suspension cannot bypass it.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let payload: TokenPayload;
    try {
      payload = jwt.verify(header.slice(7), env().JWT_SECRET) as TokenPayload;
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const row = await selectOne<UserRow>(
      'SELECT id, name, email, role, account_status, rejection_reason FROM users WHERE id = $1',
      [payload.sub],
    );
    if (!row) throw unauthorized('Account no longer exists');
    if (row.account_status === 'SUSPENDED') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
    }
    (req as AuthedRequest).user = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      accountStatus: row.account_status,
      rejectionReason: row.rejection_reason,
    };
    next();
  } catch (err) {
    next(err);
  }
};

export function currentUser(req: Request): AuthUser {
  const user = (req as AuthedRequest).user;
  if (!user) throw unauthorized();
  return user;
}

/** Role gate. Managers must additionally be ACTIVE (approved) to pass. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = currentUser(req);
      if (!roles.includes(user.role)) throw forbidden();
      if (user.role === 'THEATRE_MANAGER' && user.accountStatus !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Your manager account is not approved', {
          accountStatus: user.accountStatus,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Role gate that does not require approval; used by the manager account-status endpoints. */
export function requireRoleAnyStatus(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    try {
      if (!roles.includes(currentUser(req).role)) throw forbidden();
      next();
    } catch (err) {
      next(err);
    }
  };
}
