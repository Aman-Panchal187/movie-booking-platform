import bcrypt from 'bcrypt';
import { env } from '../../shared/config/env';
import { execute, selectOne } from '../../shared/database/sequelize';
import { AppError, conflict, unauthorized } from '../../shared/errors/errors';
import { AccountStatus, Role, signToken } from '../../shared/middleware/auth';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  accountStatus: AccountStatus;
  rejectionReason: string | null;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  account_status: AccountStatus;
  rejection_reason: string | null;
}

const toPublic = (r: UserRow): PublicUser => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  accountStatus: r.account_status,
  rejectionReason: r.rejection_reason,
});

// Compared against when the email is unknown so response time does not reveal account existence.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
  role: 'CUSTOMER' | 'THEATRE_MANAGER';
}) {
  const hash = await bcrypt.hash(input.password, env().BCRYPT_ROUNDS);
  const status: AccountStatus = input.role === 'CUSTOMER' ? 'ACTIVE' : 'PENDING_APPROVAL';
  const rows = await execute<UserRow>(
    `INSERT INTO users (name, email, password_hash, role, account_status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (LOWER(email)) DO NOTHING
     RETURNING id, name, email, password_hash, role, account_status, rejection_reason`,
    [input.name.trim(), input.email.trim().toLowerCase(), hash, input.role, status],
  );
  const row = rows[0];
  if (!row) throw conflict('An account with this email already exists');
  return { user: toPublic(row), token: signToken({ id: row.id, role: row.role }) };
}

export async function loginUser(email: string, password: string) {
  const row = await selectOne<UserRow>(
    `SELECT id, name, email, password_hash, role, account_status, rejection_reason
       FROM users WHERE LOWER(email) = LOWER($1)`,
    [email.trim()],
  );
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) throw unauthorized('Incorrect email or password');
  if (row.account_status === 'SUSPENDED') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
  }
  return { user: toPublic(row), token: signToken({ id: row.id, role: row.role }) };
}

export async function createAdminAccount(input: { name: string; email: string; password: string }) {
  const hash = await bcrypt.hash(input.password, Math.max(env().BCRYPT_ROUNDS, 12));
  const rows = await execute<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, account_status)
     VALUES ($1, $2, $3, 'ADMIN', 'ACTIVE')
     ON CONFLICT (LOWER(email)) DO NOTHING
     RETURNING id`,
    [input.name, input.email.toLowerCase(), hash],
  );
  return rows[0]?.id ?? null;
}
