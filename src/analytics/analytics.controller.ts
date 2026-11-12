import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('gmv')
  gmv(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.gmv(from, to);
  }

  @Get('top-sellers')
  topSellers(@Query('from') from?: string, @Query('to') to?: string, @Query('limit') limit?: string) {
    return this.analytics.topSellers(from, to, limit);
  }
}
