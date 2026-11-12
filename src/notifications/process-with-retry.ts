import { IHeaders } from 'kafkajs';
import { sleep } from '../db';
import { DLQ_TOPIC, Sender } from '../kafka';

export interface IncomingMessage {
  key: Buffer | null;
  value: Buffer | null;
  headers?: IHeaders;
}

/**
 * Обрабатывает сообщение с повторами и экспоненциальной задержкой; после исчерпания попыток кладёт его в DLQ.
 * shortcut: повторы в памяти блокируют партицию на время задержек; при долгих сбоях — вынести в отдельный retry-топик.
 */
export async function processWithRetry(
  message: IncomingMessage,
  handle: (message: IncomingMessage) => Promise<void>,
  dlq: Sender,
  attempts = 3,
  baseDelayMs = 200,
): Promise<'ok' | 'dlq'> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await handle(message);
      return 'ok';
    } catch (e) {
      lastError = e;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  // Если отправка в DLQ упадёт, ошибка уйдёт в kafkajs: offset не закоммитится и сообщение не потеряется.
  await dlq.send({
    topic: DLQ_TOPIC,
    messages: [
      {
        key: message.key,
        value: message.value,
        headers: {
          ...message.headers,
          error: lastError instanceof Error ? lastError.message : String(lastError),
          attempts: String(attempts),
        },
      },
    ],
  });
  return 'dlq';
}
