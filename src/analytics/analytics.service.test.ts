// Интеграционный тест: нужен ClickHouse (docker compose up -d clickhouse).
// Данные пишутся прямо в deal_events в 2001 году, чтобы не пересекаться с событиями из Kafka.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createRedis } from '../redis';
import { AnalyticsService } from './analytics.service';
import { applyClickHouseSchema, createClickHouse } from './clickhouse';

const ch = createClickHouse();
const redis = createRedis();
const analytics = new AnalyticsService(ch, redis);

// Уникальный час на каждый запуск: тесты не видят данных прошлых запусков.
const hour = new Date(Date.UTC(2001, 0, 1) + randomInt(0, 300 * 24) * 3_600_000);
const from = hour.toISOString();
const to = new Date(hour.getTime() + 3_600_000).toISOString();

before(() => applyClickHouseSchema(ch));
after(() => Promise.all([ch.close(), redis.quit()]));

const row = (sellerId: string, amount: number, eventType = 'DealCompleted', eventId = randomInt(1e12, 2 ** 47)) => ({
  event_id: eventId,
  event_type: eventType,
  deal_id: randomUUID(),
  buyer_id: randomUUID(),
  seller_id: sellerId,
  amount,
  status: 'completed',
  event_time: hour.toISOString().replace('T', ' ').replace('Z', ''),
});

test('GMV считает только завершённые сделки за период и не учитывает дубли событий', async () => {
  const seller = randomUUID();
  const duplicate = row(seller, 500);
  await ch.insert({
    table: 'deal_events',
    format: 'JSONEachRow',
    values: [row(seller, 300), duplicate, duplicate, row(seller, 999, 'DealPaid')],
  });

  assert.deepEqual(await analytics.gmv(from, to), { deals: '2', gmv: '800' });
});

test('топ продавцов отсортирован по GMV', async () => {
  const [small, big] = [randomUUID(), randomUUID()];
  await ch.insert({
    table: 'deal_events',
    format: 'JSONEachRow',
    values: [row(small, 100), row(big, 700), row(big, 50)],
  });

  const top = await analytics.topSellers(from, to, '10');
  const ids = top.map((s) => s.seller_id);
  assert.ok(ids.indexOf(big) < ids.indexOf(small), 'крупный продавец выше');
  assert.deepEqual(top.find((s) => s.seller_id === big), { seller_id: big, deals: '2', gmv: '750' });
  assert.equal((await analytics.topSellers(from, to, '1')).length, 1);
});

test('некорректный период — ошибка 400', async () => {
  await assert.rejects(analytics.gmv('not-a-date', to), /from must be an ISO date/);
  await assert.rejects(analytics.gmv(to, from), /from must be before to/);
  await assert.rejects(analytics.topSellers(from, to, '1000'), /limit must be 1..100/);
});
