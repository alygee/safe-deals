import { Controller, Get, Header, Inject } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { Pool } from 'pg';
import { PG_POOL } from './deals/deals.service';

export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // heap, GC, event loop lag

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const payments = new Counter({
  name: 'deal_payments_total',
  help: 'Payment attempts by result (ok or HTTP status)',
  labelNames: ['result'],
  registers: [registry],
});

/** Express-middleware: route — шаблон пути (/deals/:id), а не сам путь, чтобы не раздувать число временных рядов. */
export function measureHttp(req: any, res: any, next: () => void) {
  const end = httpDuration.startTimer({ method: req.method });
  res.on('finish', () => end({ route: req.route?.path ?? 'unmatched', status: res.statusCode }));
  next();
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(PG_POOL) pool: Pool) {
    // Считается при каждом scrape: растущий backlog = relay не успевает или Kafka недоступна.
    new Gauge({
      name: 'outbox_unpublished',
      help: 'Events in outbox waiting for relay',
      registers: [registry],
      async collect() {
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
        this.set(rows[0].n);
      },
    });
    for (const [name, value] of [
      ['pg_pool_total', () => pool.totalCount],
      ['pg_pool_idle', () => pool.idleCount],
      ['pg_pool_waiting', () => pool.waitingCount],
    ] as const) {
      new Gauge({ name, help: `pg pool: ${name}`, registers: [registry], collect() { this.set(value()); } });
    }
  }

  @Get()
  @Header('Content-Type', registry.contentType)
  metrics() {
    return registry.metrics();
  }
}
