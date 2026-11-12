import { Pool } from 'pg';
import { inTransaction } from '../db';
import { Sender, TOPIC } from '../kafka';

/**
 * Отправляет пачку неопубликованных событий в Kafka и помечает их опубликованными.
 * Гарантия at-least-once: если отправка прошла, а коммит упал, пачка уйдёт повторно — консьюмеры дедуплицируют по event-id.
 */
export async function publishBatch(pool: Pool, producer: Sender, limit = 100): Promise<number> {
  return inTransaction(pool, async (c) => {
    const { rows } = await c.query(
      'SELECT id, type, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
      [limit],
    );
    if (rows.length === 0) return 0;

    await producer.send({
      topic: TOPIC,
      messages: rows.map((r) => ({
        key: r.payload.id,
        value: JSON.stringify(r.payload),
        headers: { 'event-id': String(r.id), 'event-type': r.type },
      })),
    });
    await c.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    return rows.length;
  });
}
