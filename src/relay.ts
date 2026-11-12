// Outbox relay: читает таблицу outbox и публикует события в Kafka.
// Запускается в одном экземпляре: при нескольких SKIP LOCKED не даст дублей, но порядок событий одной сделки может нарушиться.
import { applySchema, createPool, sleep } from './db';
import { createKafka, ensureTopics, onShutdown } from './kafka';
import { publishBatch } from './outbox/publish-batch';

async function main() {
  const pool = createPool();
  await applySchema(pool);
  const kafka = createKafka();
  await ensureTopics(kafka);
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();

  let running = true;
  onShutdown(async () => {
    running = false;
  });

  while (running) {
    const sent = await publishBatch(pool, producer).catch((e) => {
      console.error('publish failed, will retry', e);
      return 0;
    });
    if (sent === 0) await sleep(500);
  }
  await producer.disconnect();
  await pool.end();
}
main();
