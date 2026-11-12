import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from './redis';

export const RATE_LIMIT = 'RATE_LIMIT';
export interface RateLimit {
  limit: number;
  windowSec: number;
}

/**
 * Ограничение запросов с одного IP: фиксированное окно, счётчик в Redis (INCR + EXPIRE в одной транзакции).
 * Счётчик общий для всех инстансов API. Если Redis недоступен — пропускаем запрос (fail-open):
 * лимитер защищает от перегрузки, а не от потери денег, деньги защищает БД.
 * shortcut: фиксированное окно пропускает до 2×limit на стыке окон; нужна точность — sliding window на sorted set.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RATE_LIMIT) private readonly config: RateLimit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ ip?: string }>();
    const { limit, windowSec } = this.config;
    const window = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rl:${req.ip}:${window}`;

    let count: number;
    try {
      const [[err, value]] = (await this.redis.multi().incr(key).expire(key, windowSec).exec())!;
      if (err) throw err;
      count = value as number;
    } catch (e) {
      console.warn('rate limiter unavailable, allowing request', (e as Error).message);
      return true;
    }

    const res = context.switchToHttp().getResponse<{ setHeader(name: string, value: number): void }>();
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    if (count > limit) {
      res.setHeader('Retry-After', (window + 1) * windowSec - Math.floor(Date.now() / 1000));
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
