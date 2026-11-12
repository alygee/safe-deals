// Консьюмер уведомлений: читает события сделок и сохраняет уведомления продавцам.
import { applySchema, createPool } from './db';
import { createKafka, ensureTopics, onShutdown, TOPIC } from './kafka';
import { notifySeller } from './notifications/notify-seller';
import { processWithRetry } from './notifications/process-with-retry';

async function main() {
  const pool = createPool();
  await applySchema(pool);
  const kafka = createKafka();
  await ensureTopics(kafka);

  const dlq = kafka.producer();
  const consumer = kafka.consumer({ groupId: 'notifications' });
  await Promise.all([dlq.connect(), consumer.connect()]);
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  const handle = notifySeller(pool);
  // Offset коммитится после успешного eachMessage, поэтому доставка at-least-once.
  await consumer.run({
    eachMessage: async ({ message }) => {
      const result = await processWithRetry(message, handle, dlq);
      if (result === 'dlq') console.error('message sent to DLQ', message.headers?.['event-id']?.toString());
    },
  });

  onShutdown(async () => {
    await consumer.disconnect();
    await dlq.disconnect();
    await pool.end();
  });
}
main();
