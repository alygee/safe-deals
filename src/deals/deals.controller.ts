import { Body, Controller, Get, Headers, HttpException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { payments } from '../metrics';
import { RateLimitGuard } from '../rate-limit.guard';
import { DealsService } from './deals.service';

@Controller()
@UseGuards(RateLimitGuard)
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Post('accounts')
  createAccount(@Body() body: { balance: number }) {
    return this.deals.createAccount(body?.balance);
  }

  @Get('accounts/:id')
  getAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.deals.getAccount(id);
  }

  @Post('deals')
  create(@Body() body: { buyerId: string; sellerId: string; amount: number }) {
    return this.deals.create(body?.buyerId, body?.sellerId, body?.amount);
  }

  @Get('deals/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.deals.get(id);
  }

  @Post('deals/:id/pay')
  async pay(@Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string) {
    try {
      const deal = await this.deals.pay(id, key);
      payments.inc({ result: 'ok' });
      return deal;
    } catch (e) {
      payments.inc({ result: e instanceof HttpException ? String(e.getStatus()) : 'error' });
      throw e;
    }
  }

  @Post('deals/:id/confirm')
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    return this.deals.confirm(id);
  }
}
