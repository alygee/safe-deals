// Интеграционный тест: нужен Redis (docker compose up -d redis).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type Redis from 'ioredis';
import { cached, createRedis } from './redis';

const redis = createRedis();
after(() => redis.quit());

test('второй вызов берётся из кэша', async () => {
  const key = `test:${randomUUID()}`;
  let calls = 0;
  const compute = async () => ({ value: ++calls });

  assert.deepEqual(await cached(redis, key, 30, compute), { value: 1 });
  assert.deepEqual(await cached(redis, key, 30, compute), { value: 1 });
  assert.equal(calls, 1);
  assert.ok((await redis.ttl(key)) > 0, 'ключ с TTL');
});

test('Redis недоступен: значение считается без кэша', async () => {
  const broken = {
    get: async () => { throw new Error('ECONNREFUSED'); },
    set: async () => { throw new Error('ECONNREFUSED'); },
  } as unknown as Redis;

  assert.equal(await cached(broken, 'k', 30, async () => 42), 42);
});
