// Интеграционный тест с PostgreSQL; Kafka заменена фейковым продюсером.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { applySchema, createPool } from '../db';
import { DealsService } from '../deals/deals.service';
import { Sender } from '../kafka';
import { publishBatch } from './publish-batch';

const pool = createPool();
const deals = new DealsService(pool);

before(() => applySchema(pool));
after(() => pool.end());

async function newDeal() {
  const buyer = await deals.createAccount(1000);
  const seller = await deals.createAccount(0);
  return deals.create(buyer.id, seller.id, 100);
}

const unpublishedFor = async (dealId: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM outbox WHERE payload->>'id' = $1 AND published_at IS NULL", [dealId]))
    .rows[0].n;

test('события уходят в Kafka с ключом-сделкой и заголовками и помечаются опубликованными', async () => {
  const deal = await newDeal();
  const sent: any[] = [];
  const producer: Sender = { send: async (r) => (sent.push(...r.messages), []) };

  while ((await publishBatch(pool, producer)) > 0);

  const msg = sent.find((m) => m.key === deal.id);
  assert.ok(msg, 'событие сделки отправлено');
  assert.equal(msg.headers['event-type'], 'DealCreated');
  assert.match(msg.headers['event-id'], /^\d+$/);
  assert.equal(JSON.parse(msg.value).id, deal.id);
  assert.equal(await unpublishedFor(deal.id), 0);
});

test('если Kafka недоступна, события остаются неопубликованными', async () => {
  const deal = await newDeal();
  const failing: Sender = { send: async () => { throw new Error('kafka down'); } };

  await assert.rejects(publishBatch(pool, failing), /kafka down/);
  assert.equal(await unpublishedFor(deal.id), 1);
});
