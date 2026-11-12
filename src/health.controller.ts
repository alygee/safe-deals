import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from './deals/deals.service';

// Для health check в haproxy: инстанс без доступа к БД выводится из балансировки.
// Без rate limit — проверки идут каждые 2 секунды.
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
  }
}
