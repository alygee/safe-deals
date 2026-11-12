// Интеграционный тест: нужен Redis (docker compose up -d redis).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import type Redis from 'ioredis';
import { RateLimitGuard } from './rate-limit.guard';
import { createRedis } from './redis';

const redis = createRedis();
after(() => redis.quit());

function request(ip: string) {
  const headers: Record<string, unknown> = {};
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
      getResponse: () => ({ setHeader: (k: string, v: unknown) => (headers[k] = v) }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, headers };
}

test('после лимита — 429 с Retry-After, другой IP не затронут', async () => {
  const guard = new RateLimitGuard(redis, { limit: 3, windowSec: 60 });
  const ip = `test-${randomUUID()}`;

  for (let i = 0; i < 3; i++) assert.equal(await guard.canActivate(request(ip).ctx), true);

  const blocked = request(ip);
  await assert.rejects(guard.canActivate(blocked.ctx), (e: any) => e.getStatus() === 429);
  assert.equal(blocked.headers['X-RateLimit-Remaining'], 0);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);

  assert.equal(await guard.canActivate(request(`test-${randomUUID()}`).ctx), true);
});

test('параллельные запросы считаются атомарно', async () => {
  const guard = new RateLimitGuard(redis, { limit: 5, windowSec: 60 });
  const ip = `test-${randomUUID()}`;

  const results = await Promise.allSettled(Array.from({ length: 20 }, () => guard.canActivate(request(ip).ctx)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
});

test('Redis недоступен — запрос пропускается (fail-open)', async () => {
  const broken = { multi: () => ({ incr: () => ({ expire: () => ({ exec: async () => { throw new Error('down'); } }) }) }) };
  const guard = new RateLimitGuard(broken as unknown as Redis, { limit: 1, windowSec: 60 });
  assert.equal(await guard.canActivate(request('any').ctx), true);
});
