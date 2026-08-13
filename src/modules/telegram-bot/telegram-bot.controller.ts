import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { Update } from 'grammy/types';
import { Public } from '../../common/decorators/public.decorator';
import { TelegramBotService } from './telegram-bot.service';

@Controller('telegram')
export class TelegramBotController {
  private readonly logger = new Logger(TelegramBotController.name);

  constructor(private readonly telegramBotService: TelegramBotService) {}

  @Public()
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: Request,
    @Headers('x-telegram-bot-api-secret-token') secretHeader?: string,
  ) {
    if (!this.telegramBotService.isReady()) {
      this.logger.warn('Webhook update ignored: Telegram bot not ready');
      return { ok: true };
    }

    const expected = this.telegramBotService.getWebhookSecret();
    if (expected && secretHeader !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    const update = req.body as Update;
    await this.telegramBotService.handleUpdate(update);
    return { ok: true };
  }
}
