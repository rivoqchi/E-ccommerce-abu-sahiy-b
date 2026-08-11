import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

/** Lightweight keep-alive for cron-job.org / Render free tier. */
@Controller('ping')
@Public()
export class PingController {
  @Get()
  ping() {
    return { ok: true, pong: true };
  }
}
