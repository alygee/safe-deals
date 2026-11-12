import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ClickHouseClient } from '@clickhouse/client';
import type Redis from 'ioredis';
import { cached, REDIS } from '../redis';
import { CLICKHOUSE } from './clickhouse';

// Запросы с FINAL дорогие, а свежесть до секунды аналитике не нужна.
const CACHE_TTL_SEC = Number(process.env.ANALYTICS_CACHE_TTL_SEC ?? 30);

// UInt64 ClickHouse отдаёт в JSON строками — так же, как деньги в API сделок.
export interface Gmv {
  deals: string;
  gmv: string;
}
export interface SellerStats extends Gmv {
  seller_id: string;
}

const PERIOD = `event_type = 'DealCompleted'
  AND event_time >= parseDateTime64BestEffort({from:String}, 3)
  AND event_time <  parseDateTime64BestEffort({to:String}, 3)`;

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(CLICKHOUSE) private readonly ch: ClickHouseClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** GMV — сумма завершённых сделок за период [from, to). */
  async gmv(from?: string, to?: string): Promise<Gmv> {
    const p = period(from, to); // валидация до кэша: мусор не попадает в ключи
    return cached(this.redis, `analytics:gmv:${p.from}:${p.to}`, CACHE_TTL_SEC, async () => {
      const [row] = await this.query<Gmv>(
        `SELECT count() AS deals, sum(amount) AS gmv FROM deal_events FINAL WHERE ${PERIOD}`,
        p,
      );
      return row;
    });
  }

  async topSellers(from?: string, to?: string, limit = '10'): Promise<SellerStats[]> {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new BadRequestException('limit must be 1..100');
    const p = period(from, to);
    return cached(this.redis, `analytics:top:${p.from}:${p.to}:${n}`, CACHE_TTL_SEC, () =>
      this.query<SellerStats>(
        `SELECT seller_id, count() AS deals, sum(amount) AS gmv
         FROM deal_events FINAL WHERE ${PERIOD}
         GROUP BY seller_id ORDER BY sum(amount) DESC LIMIT {limit:UInt32}`,
        { ...p, limit: n },
      ),
    );
  }

  private async query<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
    const result = await this.ch.query({ query, query_params, format: 'JSONEachRow' });
    return result.json<T>();
  }
}

function period(from?: string, to?: string) {
  const parse = (value: string | undefined, name: string) => {
    const date = new Date(value ?? '');
    if (!value || Number.isNaN(date.getTime())) throw new BadRequestException(`${name} must be an ISO date`);
    return date.toISOString();
  };
  const range = { from: parse(from, 'from'), to: parse(to, 'to') };
  if (range.from >= range.to) throw new BadRequestException('from must be before to');
  return range;
}
