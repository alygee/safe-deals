import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applySchema, createPool } from './db';
import { DealsController } from './deals/deals.controller';
import { DealsService, PG_POOL } from './deals/deals.service';
import { HealthController } from './health.controller';
import { measureHttp, MetricsController } from './metrics';
import { RATE_LIMIT, RateLimitGuard } from './rate-limit.guard';
import { createRedis, REDIS } from './redis';

@Module({
  controllers: [DealsController, HealthController, MetricsController],
  providers: [
    DealsService,
    { provide: PG_POOL, useFactory: createPool },
    { provide: REDIS, useFactory: createRedis },
    {
      provide: RATE_LIMIT,
      useValue: { limit: Number(process.env.RATE_LIMIT ?? 100), windowSec: Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60) },
    },
    RateLimitGuard,
  ],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // За nginx и haproxy адрес клиента берётся из X-Forwarded-For с учётом числа доверенных прокси.
  // Без этого все пользователи попадали бы под один лимит — с адреса haproxy.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.use(measureHttp);
  await applySchema(app.get(PG_POOL));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
