// Интеграционный тест с PostgreSQL.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { applySchema, createPool } from '../db';
import { notifySeller } from './notify-seller';

const pool = createPool();
const handle = notifySeller(pool);

before(() => applySchema(pool));
after(() => pool.end());

const event = (type: string, eventId = String(randomInt(1e9, 2 ** 47))) => ({
  key: null,
  value: Buffer.from(JSON.stringify({ id: randomUUID(), seller_id: randomUUID() })),
  headers: { 'event-id': eventId, 'event-type': type },
});

const countFor = async (eventId: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE event_id = $1', [eventId])).rows[0].n;

test('повторная доставка события создаёт одно уведомление', async () => {
  const msg = event('DealPaid');
  await handle(msg);
  await handle(msg);
  assert.equal(await countFor(msg.headers['event-id']), 1);
});

test('неизвестный тип события пропускается', async () => {
  const msg = event('SomethingElse');
  await handle(msg);
  assert.equal(await countFor(msg.headers['event-id']), 0);
});

test('сообщение без event-id — ошибка (уйдёт в DLQ)', async () => {
  await assert.rejects(handle({ key: null, value: Buffer.from('{}'), headers: {} }), /malformed/);
});
