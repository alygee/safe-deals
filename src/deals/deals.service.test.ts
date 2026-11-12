// Интеграционные тесты: нужен PostgreSQL (docker compose up -d postgres).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { applySchema, createPool } from '../db';
import { DealsService } from './deals.service';

const pool = createPool();
const service = new DealsService(pool);

before(() => applySchema(pool));
after(() => pool.end());

async function setup(buyerBalance: number, amount: number) {
  const buyer = await service.createAccount(buyerBalance);
  const seller = await service.createAccount(0);
  const deal = await service.create(buyer.id, seller.id, amount);
  return { buyer, seller, deal };
}

test('полный цикл: оплата замораживает деньги, подтверждение переводит продавцу', async () => {
  const { buyer, seller, deal } = await setup(1000, 300);

  await service.pay(deal.id, `k-${deal.id}`);
  assert.deepEqual(await service.getAccount(buyer.id), { id: buyer.id, balance: '700', held: '300' });

  const done = await service.confirm(deal.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(await service.getAccount(buyer.id), { id: buyer.id, balance: '700', held: '0' });
  assert.equal((await service.getAccount(seller.id)).balance, '300');
});

test('повтор оплаты с тем же ключом не списывает деньги дважды', async () => {
  const { buyer, deal } = await setup(1000, 300);
  const key = `k-${deal.id}`;

  const first = await service.pay(deal.id, key);
  const retry = await service.pay(deal.id, key);
  assert.deepEqual(retry, first);
  assert.equal((await service.getAccount(buyer.id)).balance, '700');
});

test('20 параллельных оплат одной сделки разными ключами: успешна ровно одна', async () => {
  const { buyer, deal } = await setup(1000, 300);

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => service.pay(deal.id, `k-${deal.id}-${i}`)),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(await service.getAccount(buyer.id), { id: buyer.id, balance: '700', held: '300' });
});

test('параллельные оплаты разных сделок не уводят баланс в минус', async () => {
  const buyer = await service.createAccount(1000);
  const seller = await service.createAccount(0);
  const deals = await Promise.all(Array.from({ length: 10 }, () => service.create(buyer.id, seller.id, 300)));

  const results = await Promise.allSettled(deals.map((d) => service.pay(d.id, `k-${d.id}`)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3); // 3 × 300 ≤ 1000
  assert.deepEqual(await service.getAccount(buyer.id), { id: buyer.id, balance: '100', held: '900' });
});

test('нельзя подтвердить неоплаченную сделку', async () => {
  const { deal } = await setup(1000, 300);
  await assert.rejects(service.confirm(deal.id), /deal is created/);
});

test('недостаточно средств: оплата отклоняется, баланс не меняется', async () => {
  const { buyer, deal } = await setup(100, 300);
  await assert.rejects(service.pay(deal.id, `k-${deal.id}`), /insufficient funds/);
  assert.deepEqual(await service.getAccount(buyer.id), { id: buyer.id, balance: '100', held: '0' });
});
