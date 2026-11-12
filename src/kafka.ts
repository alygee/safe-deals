import { Kafka, logLevel, Producer } from 'kafkajs';

export const TOPIC = 'deals.events';
export const DLQ_TOPIC = 'deals.events.dlq';

export type Sender = Pick<Producer, 'send'>;

export const createKafka = () =>
  new Kafka({
    clientId: 'safe-deals',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    logLevel: logLevel.WARN,
  });

export async function ensureTopics(kafka: Kafka) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    // Ключ сообщения — id сделки, поэтому события одной сделки попадают в одну партицию и идут по порядку.
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: TOPIC, numPartitions: 3 },
        { topic: DLQ_TOPIC, numPartitions: 1 },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}

export function onShutdown(fn: () => Promise<void>) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => fn().then(() => process.exit(0)));
}
