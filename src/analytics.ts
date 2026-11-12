// Сервис аналитики: читает агрегаты из ClickHouse, который сам забирает события из Kafka.
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AnalyticsController } from './analytics/analytics.controller';
import { AnalyticsService } from './analytics/analytics.service';
import { applyClickHouseSchema, CLICKHOUSE, createClickHouse } from './analytics/clickhouse';
import { createRedis, REDIS } from './redis';

@Module({
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    { provide: CLICKHOUSE, useFactory: createClickHouse },
    { provide: REDIS, useFactory: createRedis },
  ],
})
class AnalyticsModule {}

async function bootstrap() {
  const app = await NestFactory.create(AnalyticsModule);
  await applyClickHouseSchema(app.get(CLICKHOUSE));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}
bootstrap();
