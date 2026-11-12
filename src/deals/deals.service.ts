import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { inTransaction } from '../db';

export const PG_POOL = 'PG_POOL';

export interface Deal {
  id: string;
  buyer_id: string;
  seller_id: string;
  amount: string; // bigint из pg приходит строкой — не теряем точность
  status: 'created' | 'paid' | 'completed';
}

const DEAL_COLUMNS = 'id, buyer_id, seller_id, amount, status';

@Injectable()
export class DealsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createAccount(balance: number): Promise<{ id: string }> {
    if (!Number.isSafeInteger(balance) || balance < 0) throw new BadRequestException('balance must be a non-negative integer');
    const { rows } = await this.pool.query('INSERT INTO accounts (balance) VALUES ($1) RETURNING id', [balance]);
    return rows[0];
  }

  async getAccount(id: string) {
    const { rows } = await this.pool.query('SELECT id, balance, held FROM accounts WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('account not found');
    return rows[0];
  }

  async create(buyerId: string, sellerId: string, amount: number): Promise<Deal> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestException('amount must be a positive integer');
    if (buyerId === sellerId) throw new BadRequestException('buyer and seller must differ');
    return inTransaction(this.pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO deals (buyer_id, seller_id, amount) VALUES ($1, $2, $3) RETURNING ${DEAL_COLUMNS}`,
        [buyerId, sellerId, amount],
      );
      await this.emit(c, 'DealCreated', rows[0]);
      return rows[0];
    });
  }

  async get(id: string): Promise<Deal> {
    const { rows } = await this.pool.query(`SELECT ${DEAL_COLUMNS} FROM deals WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('deal not found');
    return rows[0];
  }

  /** Замораживает деньги покупателя. Повтор с тем же ключом возвращает тот же результат без повторного списания. */
  async pay(dealId: string, idempotencyKey: string): Promise<Deal> {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    return inTransaction(this.pool, async (c) => {
      // Уникальность по ключу и по deal_id: параллельная вторая оплата ждёт здесь, пока первая не закоммитится.
      const inserted = await c.query(
        'INSERT INTO payments (idempotency_key, deal_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [idempotencyKey, dealId],
      );
      if (inserted.rowCount === 0) {
        const { rows } = await c.query('SELECT deal_id FROM payments WHERE idempotency_key = $1', [idempotencyKey]);
        if (rows[0]?.deal_id === dealId) return this.lockDeal(c, dealId); // повтор того же запроса
        throw new ConflictException(rows[0] ? 'idempotency key used for another deal' : 'deal already paid');
      }

      const deal = await this.lockDeal(c, dealId);
      if (deal.status !== 'created') throw new ConflictException(`deal is ${deal.status}`);

      const debited = await c.query(
        'UPDATE accounts SET balance = balance - $2, held = held + $2 WHERE id = $1 AND balance >= $2',
        [deal.buyer_id, deal.amount],
      );
      if (debited.rowCount === 0) throw new UnprocessableEntityException('insufficient funds');

      return this.setStatus(c, deal, 'paid', 'DealPaid');
    });
  }

  /** Покупатель подтвердил получение: замороженные деньги уходят продавцу. */
  async confirm(dealId: string): Promise<Deal> {
    return inTransaction(this.pool, async (c) => {
      const deal = await this.lockDeal(c, dealId);
      if (deal.status !== 'paid') throw new ConflictException(`deal is ${deal.status}`);
      await c.query('UPDATE accounts SET held = held - $2 WHERE id = $1', [deal.buyer_id, deal.amount]);
      await c.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1', [deal.seller_id, deal.amount]);
      return this.setStatus(c, deal, 'completed', 'DealCompleted');
    });
  }

  private async lockDeal(c: PoolClient, id: string): Promise<Deal> {
    const { rows } = await c.query(`SELECT ${DEAL_COLUMNS} FROM deals WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new NotFoundException('deal not found');
    return rows[0];
  }

  private async setStatus(c: PoolClient, deal: Deal, status: Deal['status'], event: string): Promise<Deal> {
    const { rows } = await c.query(
      `UPDATE deals SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${DEAL_COLUMNS}`,
      [deal.id, status],
    );
    await this.emit(c, event, rows[0]);
    return rows[0];
  }

  private emit(c: PoolClient, type: string, payload: unknown) {
    return c.query('INSERT INTO outbox (type, payload) VALUES ($1, $2)', [type, JSON.stringify(payload)]);
  }
}
