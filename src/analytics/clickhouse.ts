import { createClient, ClickHouseClient } from '@clickhouse/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLICKHOUSE = 'CLICKHOUSE';

export const createClickHouse = () =>
  createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'analytics',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'analytics',
    database: process.env.CLICKHOUSE_DB ?? 'analytics',
  });

// Адрес Kafka указывается так, как его видит ClickHouse (внутри docker-сети), а не как видит приложение.
export async function applyClickHouseSchema(ch: ClickHouseClient) {
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'clickhouse.sql'), 'utf8')
    .replaceAll('{KAFKA_BROKERS}', process.env.CLICKHOUSE_KAFKA_BROKERS ?? 'kafka:19092');
  // HTTP-интерфейс ClickHouse выполняет одну команду за запрос.
  const withoutComments = sql.replace(/^\s*--.*$/gm, '');
  for (const statement of withoutComments.split(';').map((s) => s.trim()).filter(Boolean)) {
    await ch.command({ query: statement });
  }
}
