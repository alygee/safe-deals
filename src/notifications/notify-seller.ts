import { Pool } from 'pg';
import type { Deal } from '../deals/deals.service';
import { IncomingMessage } from './process-with-retry';

const TEXTS: Record<string, string> = {
  DealCreated: 'Создана новая сделка по вашему товару',
  DealPaid: 'Покупатель оплатил сделку, передайте товар',
  DealCompleted: 'Покупатель подтвердил получение, деньги зачислены',
};

/** Сохраняет уведомление продавцу. Повторная доставка того же события ничего не меняет (ON CONFLICT по event_id). */
export function notifySeller(pool: Pool) {
  return async (message: IncomingMessage) => {
    const eventId = message.headers?.['event-id']?.toString();
    const type = message.headers?.['event-type']?.toString() ?? '';
    if (!eventId || !message.value) throw new Error('malformed message: event-id header and value are required');
    const text = TEXTS[type];
    if (!text) return; // событие нас не касается

    const deal: Deal = JSON.parse(message.value.toString());
    await pool.query(
      'INSERT INTO notifications (event_id, deal_id, account_id, text) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING',
      [eventId, deal.id, deal.seller_id, text],
    );
  };
}
