import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';

// Размер пула — главный параметр пропускной способности: транзакция оплаты держит соединение на ~5 сетевых переходов.
// По умолчанию в pg — 10; нагрузочный тест упёрся именно в него (loadtest/REPORT.md).
// Сумма по всем инстансам должна оставаться ниже max_connections PostgreSQL (по умолчанию 100).
export const createPool = () =>
  new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://deals:deals@localhost:5433/deals',
    max: Number(process.env.PG_POOL_MAX ?? 30),
  });

// shortcut: схема применяется целиком при старте; когда появятся изменения схемы — перейти на миграции (node-pg-migrate).
// Advisory lock: API, relay и консьюмер стартуют одновременно, а параллельный CREATE TABLE IF NOT EXISTS может упасть.
export async function applySchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(42)');
    await client.query(readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  } finally {
    await client.query('SELECT pg_advisory_unlock(42)').catch(() => {});
    client.release();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
