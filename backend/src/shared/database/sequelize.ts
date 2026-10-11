import pg from 'pg';
import { Sequelize, QueryTypes, Transaction } from 'sequelize';
import { env } from '../config/env';
import { moduleLogger } from '../logging/logger';

const log = moduleLogger('database');

// int8 (COUNT/SUM/money in minor units) and numeric (AVG) arrive as numbers, not strings.
// Money stays below 2^53 minor units, so this is lossless for this domain.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

function needsSsl(url: string): boolean {
  const e = env();
  if (e.DB_SSL !== undefined && process.env.DB_SSL !== undefined) return e.DB_SSL;
  return /sslmode=require/.test(url) || /neon\.tech/.test(url);
}

export function createSequelize(url = env().DATABASE_URL): Sequelize {
  return new Sequelize(url, {
    dialect: 'postgres',
    logging: false,
    pool: { max: env().DB_POOL_MAX, min: 0, idle: 10000, acquire: 30000 },
    dialectOptions: needsSsl(url) ? { ssl: { require: true, rejectUnauthorized: false } } : {},
    define: { underscored: true },
  });
}

export const sequelize = createSequelize();

export { QueryTypes, Transaction };

type Bind = Record<string, unknown> | unknown[];

/** Run a parameterized SELECT and return typed rows. */
export async function selectRows<T>(
  sql: string,
  bind: Bind = {},
  transaction?: Transaction,
): Promise<T[]> {
  return (await sequelize.query(sql, {
    bind: bind as Record<string, unknown>,
    type: QueryTypes.SELECT,
    transaction,
  })) as T[];
}

export async function selectOne<T>(
  sql: string,
  bind: Bind = {},
  transaction?: Transaction,
): Promise<T | null> {
  const rows = await selectRows<T>(sql, bind, transaction);
  return rows[0] ?? null;
}

/** Run a parameterized write; returns affected rows (RETURNING rows if present). */
export async function execute<T = Record<string, unknown>>(
  sql: string,
  bind: Bind = {},
  transaction?: Transaction,
): Promise<T[]> {
  const [rows] = (await sequelize.query(sql, {
    bind: bind as Record<string, unknown>,
    transaction,
  })) as [T[], unknown];
  return Array.isArray(rows) ? rows : [];
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await sequelize.query('SELECT 1');
    return true;
  } catch (err) {
    log.error({ err }, 'database connectivity check failed');
    return false;
  }
}
