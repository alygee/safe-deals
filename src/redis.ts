import Redis from 'ioredis';

export const REDIS = 'REDIS';

// Redis вспомогательный (кэш, лимиты): если он лёг, команда должна упасть за доли секунды, а не ждать переподключения.
// commandTimeout ограничивает каждую команду; офлайн-очередь оставлена, чтобы команды при старте дождались соединения.
export const createRedis = () =>
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 300),
  });

/**
 * Cache-aside: берём значение из Redis, иначе считаем и кладём с TTL.
 * Ошибки Redis не ломают запрос — просто считаем без кэша.
 */
export async function cached<T>(redis: Redis, key: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit);
  } catch (e) {
    console.warn('cache read failed', key, (e as Error).message);
  }
  const value = await compute();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSec).catch((e) => console.warn('cache write failed', key, e.message));
  return value;
}
