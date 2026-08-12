import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import type { Update } from 'grammy/types';
import { UsersService } from '../users/users.service';
import { OrdersService } from '../orders/orders.service';
import {
  BTN_MINI_APP,
  BTN_MY_ORDERS,
  BTN_PRICE_WEB,
  BTN_SHARE_PHONE,
  statusLabels,
  texts,
} from './telegram-bot.texts';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Bot | null = null;
  private mode: 'polling' | 'webhook' | 'off' = 'off';
  private frontendUrl = '';

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
  ) {}

  async onModuleInit() {
    const token = this.configService.get<string>('telegram.botToken')?.trim();
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN bo‘sh — Telegram bot ishga tushirilmadi',
      );
      return;
    }

    this.frontendUrl = this.configService
      .getOrThrow<string>('frontendUrl')
      .replace(/\/$/, '');
    this.bot = new Bot(token);
    this.registerHandlers(this.bot);
    this.mode = this.resolveMode();

    try {
      if (this.mode === 'webhook') {
        const appUrl = this.configService
          .getOrThrow<string>('appUrl')
          .replace(/\/$/, '');
        const prefix = this.configService.get<string>('apiPrefix') ?? 'api/v1';
        const secret =
          this.configService.get<string>('telegram.botWebhookSecret')?.trim() ||
          undefined;
        const webhookUrl = `${appUrl}/${prefix}/telegram/webhook`;
        await this.bot.api.setWebhook(webhookUrl, {
          secret_token: secret,
          drop_pending_updates: false,
        });
        this.logger.log(`Telegram bot webhook: ${webhookUrl}`);
      } else {
        await this.bot.api.deleteWebhook({ drop_pending_updates: false });
        void this.bot.start({
          onStart: (info) => {
            this.logger.log(`Telegram bot polling (@${info.username})`);
          },
        });
      }
    } catch (err) {
      this.logger.error(
        'Telegram bot start failed',
        err instanceof Error ? err.stack : String(err),
      );
      this.bot = null;
      this.mode = 'off';
    }
  }

  async onModuleDestroy() {
    if (!this.bot || this.mode !== 'polling') return;
    try {
      await this.bot.stop();
    } catch (err) {
      this.logger.warn(
        `Telegram bot stop: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  isReady(): boolean {
    return this.bot != null;
  }

  getWebhookSecret(): string {
    return (
      this.configService.get<string>('telegram.botWebhookSecret')?.trim() || ''
    );
  }

  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot) return;
    await this.bot.handleUpdate(update);
  }

  private resolveMode(): 'polling' | 'webhook' {
    const configured = this.configService
      .get<string>('telegram.botMode')
      ?.trim()
      .toLowerCase();
    if (configured === 'webhook' || configured === 'polling') {
      return configured;
    }
    const nodeEnv =
      this.configService.get<string>('nodeEnv')?.toLowerCase() ?? 'development';
    return nodeEnv === 'production' ? 'webhook' : 'polling';
  }

  private registerHandlers(bot: Bot) {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.on('message:contact', (ctx) => this.onContact(ctx));
    bot.hears(BTN_MY_ORDERS, (ctx) => this.onMyOrders(ctx));
    bot.on('message:text', (ctx) => this.onFallbackText(ctx));
  }

  private async onStart(ctx: Context) {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (user?.phone) {
      await this.replyWithMenu(ctx, texts.welcomeReady, true);
      return;
    }

    await ctx.reply(texts.welcomeNeedPhone, {
      reply_markup: this.phoneRequestKeyboard(),
    });
  }

  private async onContact(ctx: Context) {
    const from = ctx.from;
    const contact = ctx.message?.contact;
    if (!from || !contact?.phone_number) return;

    if (contact.user_id == null || contact.user_id !== from.id) {
      await ctx.reply(texts.contactRejected, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return;
    }

    try {
      await this.usersService.registerFromBotContact({
        telegramId: String(from.id),
        phone: contact.phone_number,
        firstName: contact.first_name || from.first_name,
        lastName: contact.last_name || from.last_name,
        username: from.username,
      });
      await this.replyWithMenu(ctx, texts.registered, true);
    } catch (err) {
      if (err instanceof ConflictException) {
        await ctx.reply(texts.phoneConflict, {
          reply_markup: this.phoneRequestKeyboard(),
        });
        return;
      }
      this.logger.error(
        'registerFromBotContact failed',
        err instanceof Error ? err.stack : String(err),
      );
      await ctx.reply(texts.registerFailed, {
        reply_markup: this.phoneRequestKeyboard(),
      });
    }
  }

  private async onMyOrders(ctx: Context) {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (!user?.phone) {
      await ctx.reply(texts.contactRequired, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return;
    }

    const orders = await this.ordersService.findMine(user._id.toString());
    const recent = orders.slice(0, 10);

    if (!recent.length) {
      await this.replyWithMenu(ctx, texts.noOrders, false);
      return;
    }

    const body = recent
      .map((order, index) => {
        const id = String(order._id).slice(-6).toUpperCase();
        const createdAt = (order as { createdAt?: Date }).createdAt;
        const date = createdAt
          ? new Date(createdAt).toLocaleString('uz-UZ', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—';
        const status =
          statusLabels[order.status] ?? String(order.status ?? '—');
        const items = (order.items ?? [])
          .slice(0, 3)
          .map((i) => `• ${i.name} ×${i.quantity}`)
          .join('\n');
        const more =
          (order.items?.length ?? 0) > 3
            ? `\n• … +${order.items.length - 3}`
            : '';
        return [
          `${index + 1}) #${id}`,
          `📅 ${date}`,
          `📊 ${status}`,
          `💰 ${formatMoney(order.total)}`,
          items + more,
        ].join('\n');
      })
      .join('\n\n');

    await this.replyWithMenu(ctx, `${texts.ordersHeader}\n${body}`, false);
  }

  private async onFallbackText(ctx: Context) {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith('/')) return;
    if (text === BTN_MY_ORDERS) return;

    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (!user?.phone) {
      await ctx.reply(texts.contactRequired, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return;
    }

    await this.replyWithMenu(ctx, texts.menuHint, false);
  }

  /**
   * Reply keyboard (Buyurtmalarim) persists until replaced.
   * Content messages use InlineKeyboard (Price Web + Mini App).
   * When installReplyKeyboard=true, first message installs the reply keyboard.
   */
  private async replyWithMenu(
    ctx: Context,
    message: string,
    installReplyKeyboard: boolean,
  ) {
    if (installReplyKeyboard) {
      await ctx.reply(message, {
        reply_markup: this.mainReplyKeyboard(),
      });
      await ctx.reply('🔗 Price Web / Mini App:', {
        reply_markup: this.linksInlineKeyboard(),
      });
      return;
    }

    await ctx.reply(message, {
      reply_markup: this.linksInlineKeyboard(),
    });
  }

  private phoneRequestKeyboard() {
    return new Keyboard()
      .requestContact(BTN_SHARE_PHONE)
      .resized()
      .persistent();
  }

  private mainReplyKeyboard() {
    return new Keyboard().text(BTN_MY_ORDERS).resized().persistent();
  }

  private linksInlineKeyboard() {
    return new InlineKeyboard()
      .url(BTN_PRICE_WEB, this.frontendUrl)
      .webApp(BTN_MINI_APP, this.frontendUrl);
  }
}

function formatMoney(amount: number): string {
  try {
    return new Intl.NumberFormat('uz-UZ', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount}`;
  }
}
