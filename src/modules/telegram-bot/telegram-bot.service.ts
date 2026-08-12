import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import type { Update } from 'grammy/types';
import { randomBytes } from 'crypto';
import { UsersService } from '../users/users.service';
import { OrdersService } from '../orders/orders.service';
import { AuthService } from '../auth/auth.service';
import { RedisService } from '../redis/redis.service';
import {
  BTN_MINI_APP,
  BTN_MY_ORDERS,
  BTN_OPEN_WEB,
  BTN_SEND_CODE,
  BTN_SHARE_PHONE,
  statusLabels,
  texts,
} from './telegram-bot.texts';

const POLLING_LOCK_KEY = 'telegram-bot:polling-lock';
const POLLING_LOCK_TTL_SEC = 45;
/** Default Mini App (HTTPS) — localhost Telegram web_app da ishlamaydi */
const DEFAULT_MINI_APP_URL = 'https://e-ccommerce-abu-sahiy-f.vercel.app';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Bot | null = null;
  private mode: 'polling' | 'webhook' | 'off' = 'off';
  private frontendUrl = '';
  private miniAppUrl = '';
  private readonly lockOwner = randomBytes(8).toString('hex');
  private lockRenewTimer: ReturnType<typeof setInterval> | null = null;
  private pollingRetries = 0;
  private bootstrapping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
    private readonly authService: AuthService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    const token = this.configService.get<string>('telegram.botToken')?.trim();
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN bo‘sh — Telegram bot ishga tushirilmadi',
      );
      return;
    }

    // API listenni Telegram tarmog'iga bog'lab qo'ymaymiz
    void this.bootstrapBot(token);
  }

  private async bootstrapBot(token: string) {
    if (this.bootstrapping) return;
    this.bootstrapping = true;
    try {
      await this.stopPollingQuietly();

      // Dev: eski crash lockini tozalash
      const nodeEnv =
        this.configService.get<string>('nodeEnv')?.toLowerCase() ?? 'development';
      if (nodeEnv !== 'production') {
        await this.redisService.del(POLLING_LOCK_KEY);
      }

      this.frontendUrl = this.configService
        .getOrThrow<string>('frontendUrl')
        .replace(/\/$/, '');
      const configuredMini = this.configService
        .get<string>('telegram.miniAppUrl')
        ?.trim()
        .replace(/\/$/, '');
      this.miniAppUrl = this.isHttpsUrl(configuredMini || '')
        ? (configuredMini as string)
        : DEFAULT_MINI_APP_URL;
      this.bot = new Bot(token, {
        client: {
          // Default juda uzoq — tarmoq sekin bo'lsa boot tiqilib qolardi
          timeoutSeconds: 25,
        },
      });
      this.registerHandlers(this.bot);
      this.bot.catch((ctx) => {
        const err = ctx.error;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('409') || msg.includes('Conflict')) {
          this.logger.warn(
            'Telegram 409: boshqa getUpdates ishlamoqda — qayta uriniladi.',
          );
          return;
        }
        this.logger.error(`Telegram bot error: ${msg}`);
      });
      this.mode = this.resolveMode();
      this.logger.log(
        `Telegram bot bootstrap (${this.mode}), Mini App: ${this.miniAppUrl}`,
      );
      await this.startBotWithRetry(this.bot, this.mode);
      await this.syncMiniAppMenuButton();
    } catch (err) {
      this.logger.error(
        'Telegram bot start failed (api.telegram.org ga ulanish yo‘q — VPN yoqing)',
        err instanceof Error ? err.message : String(err),
      );
      this.bot = null;
      this.mode = 'off';
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          const t = this.configService.get<string>('telegram.botToken')?.trim();
          if (t && !this.bot) void this.bootstrapBot(t);
        }, 30_000);
      }
    } finally {
      this.bootstrapping = false;
    }
  }

  private async startBotWithRetry(
    bot: Bot,
    mode: 'polling' | 'webhook',
    attempts = 5,
  ) {
    let lastError: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        if (mode === 'webhook') {
          const appUrl = this.configService
            .getOrThrow<string>('appUrl')
            .replace(/\/$/, '');
          const prefix = this.configService.get<string>('apiPrefix') ?? 'api/v1';
          const secret =
            this.configService
              .get<string>('telegram.botWebhookSecret')
              ?.trim() || undefined;
          const webhookUrl = `${appUrl}/${prefix}/telegram/webhook`;
          await bot.api.setWebhook(webhookUrl, {
            secret_token: secret,
            drop_pending_updates: false,
          });
          this.logger.log(`Telegram bot webhook: ${webhookUrl}`);
        } else {
          const locked = await this.acquirePollingLock();
          if (!locked) {
            this.logger.warn(
              'Telegram polling skip: boshqa backend instance allaqachon botni ushlab turibdi (Redis lock).',
            );
            this.mode = 'off';
            return;
          }

          this.logger.log(
            `Telegram polling start (attempt ${i}/${attempts})…`,
          );
          // deleteWebhook ixtiyoriy — tarmoq sekin bo'lsa o'tkazib yuboramiz
          try {
            await Promise.race([
              bot.api.deleteWebhook({ drop_pending_updates: true }),
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error('deleteWebhook timeout')), 8000),
              ),
            ]);
            this.logger.log('Telegram webhook cleared');
          } catch (err) {
            this.logger.warn(
              `deleteWebhook skip: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          try {
            await bot.init();
            this.logger.log(
              `Telegram init ok (@${bot.botInfo.username ?? 'unknown'})`,
            );
          } catch (err) {
            throw new Error(
              `bot.init failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          this.pollingRetries = 0;
          this.mode = 'polling';
          this.beginPolling(bot);
          this.logger.log(
            `Telegram bot polling (@${bot.botInfo.username ?? 'samipricebot'})`,
          );
        }
        return;
      } catch (err) {
        lastError = err;
        await this.releasePollingLock();
        const waitMs = Math.min(2000 * 2 ** (i - 1), 20000);
        this.logger.warn(
          `Telegram bot start retry ${i}/${attempts} in ${waitMs}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError;
  }

  private beginPolling(bot: Bot) {
    this.logger.log('Telegram getUpdates loop ishga tushmoqda…');
    void bot
      .start({
        drop_pending_updates: true,
        onStart: (info) => {
          this.logger.log(`Telegram bot ready (@${info.username})`);
        },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('409') || msg.includes('Conflict')) {
          this.pollingRetries += 1;
          if (this.pollingRetries <= 5 && this.bot === bot) {
            const waitMs = 4000 * this.pollingRetries;
            this.logger.warn(
              `Telegram 409 Conflict — ${waitMs}ms dan keyin qayta polling (${this.pollingRetries}/5)`,
            );
            setTimeout(() => {
              if (this.bot === bot && this.mode === 'polling') {
                this.beginPolling(bot);
              }
            }, waitMs);
            return;
          }
          this.logger.warn(
            'Telegram 409: polling to‘xtatildi. Faqat bitta backend ishlating.',
          );
          void this.releasePollingLock();
          this.mode = 'off';
          return;
        }
        this.logger.error(`Telegram polling stopped: ${msg}`);
        void this.releasePollingLock();
        this.mode = 'off';
      });
  }

  private async acquirePollingLock(): Promise<boolean> {
    // O'zimizning eski lockni tozalash (crash/restart)
    await this.redisService.getDelIfMatch(POLLING_LOCK_KEY, this.lockOwner);

    const acquired = await this.redisService.setNx(
      POLLING_LOCK_KEY,
      this.lockOwner,
      POLLING_LOCK_TTL_SEC,
    );
    if (!acquired) {
      // Stale lock: agar TTL tugagan bo'lsa keyinroq olinadi; hozir boshqa instance bor
      const current = await this.redisService.get(POLLING_LOCK_KEY);
      if (!current) {
        return this.redisService.setNx(
          POLLING_LOCK_KEY,
          this.lockOwner,
          POLLING_LOCK_TTL_SEC,
        );
      }
      return false;
    }

    this.startLockRenewal();
    return true;
  }

  private startLockRenewal() {
    this.stopLockRenewal();
    this.lockRenewTimer = setInterval(() => {
      void this.redisService.renewIfMatch(
        POLLING_LOCK_KEY,
        this.lockOwner,
        POLLING_LOCK_TTL_SEC,
      );
    }, 15_000);
  }

  private stopLockRenewal() {
    if (this.lockRenewTimer) {
      clearInterval(this.lockRenewTimer);
      this.lockRenewTimer = null;
    }
  }

  private async releasePollingLock() {
    this.stopLockRenewal();
    await this.redisService.getDelIfMatch(POLLING_LOCK_KEY, this.lockOwner);
  }

  async onModuleDestroy() {
    await this.stopPollingQuietly();
  }

  private async stopPollingQuietly() {
    this.stopLockRenewal();
    if (!this.bot) {
      await this.releasePollingLock();
      return;
    }
    try {
      if (this.mode === 'polling') {
        await this.bot.stop();
      }
    } catch (err) {
      this.logger.warn(
        `Telegram bot stop: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await this.releasePollingLock();
      this.bot = null;
      if (this.mode === 'polling') this.mode = 'off';
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
    bot.hears(BTN_SEND_CODE, (ctx) => this.onSendCode(ctx));
    bot.hears(BTN_OPEN_WEB, (ctx) => this.onOpenWebText(ctx));
    bot.hears(BTN_MINI_APP, (ctx) => this.onMiniAppText(ctx));
    bot.callbackQuery('open_web', (ctx) => this.onOpenWebCallback(ctx));
    bot.callbackQuery('send_code', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await this.onSendCode(ctx);
    });
    bot.callbackQuery('mini_app', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await this.onMiniAppText(ctx);
    });
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
    } catch (err) {
      const status =
        err instanceof HttpException ? err.getStatus() : undefined;
      if (status === 409) {
        await ctx.reply(texts.phoneConflict, {
          reply_markup: this.phoneRequestKeyboard(),
        });
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `registerFromBotContact failed telegramId=${from.id} phone=${contact.phone_number}: ${detail}`,
        err instanceof Error ? err.stack : undefined,
      );
      await ctx.reply(
        `${texts.registerFailed}\n\n(${detail.slice(0, 120)})`,
        {
          reply_markup: this.phoneRequestKeyboard(),
        },
      );
      return;
    }

    // Ro‘yxatdan o‘tish muvaffaqiyatli — menyu yuborish alohida (Telegram
    // localhost/http web_app/url ni rad etadi; shu yiqilishi registerFailed
    // ko‘rinmasligi kerak).
    await this.replyWithMenu(ctx, texts.registered, true);
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

  private async onSendCode(ctx: Context) {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (!user?.phone) {
      await ctx.reply(texts.contactRequired, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return;
    }

    try {
      const { code } = await this.authService.issueBotLoginCode(
        String(telegramId),
      );
      await ctx.reply(texts.codeSent(code), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().copyText('Copy Code', code),
      });
      await ctx.reply('Kodni /login sahifasiga kiriting.', {
        reply_markup: this.mainReplyKeyboard(),
      });
    } catch (err) {
      const status =
        err instanceof HttpException ? err.getStatus() : undefined;
      if (status === 429) {
        await ctx.reply(texts.codeCooldown);
        return;
      }
      this.logger.error(
        `issueBotLoginCode failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await ctx.reply(texts.codeFailed);
    }
  }

  private async onFallbackText(ctx: Context) {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith('/')) return;
    if (
      text === BTN_MY_ORDERS ||
      text === BTN_SEND_CODE ||
      text === BTN_OPEN_WEB ||
      text === BTN_MINI_APP
    ) {
      return;
    }

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

  /** Pastki reply keyboard — Mini App doim web_app (Telegram ichida ochiladi) */
  private async replyWithMenu(
    ctx: Context,
    message: string,
    _installReplyKeyboard = true,
  ) {
    try {
      await ctx.reply(message, {
        reply_markup: this.mainReplyKeyboard(),
      });
    } catch (err) {
      this.logger.warn(
        `replyWithMenu primary: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await ctx.reply(message);
    }
  }

  private async onOpenWebText(ctx: Context) {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (!user?.phone) {
      await ctx.reply(texts.contactRequired, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return;
    }

    await this.sendOpenWebLinkFallback(ctx, String(telegramId));
  }

  private async onOpenWebCallback(ctx: Context) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (!user?.phone) {
      await ctx.reply(texts.contactRequired, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return;
    }

    await this.sendOpenWebLinkFallback(ctx, String(telegramId));
  }

  private async onMiniAppText(ctx: Context) {
    // Eski text tugma qolgan bo‘lsa — web_app keyboardni qayta o‘rnatamiz
    await ctx.reply(
      'Mini App tugmasini qayta bosing — Telegram ichida ochiladi.',
      { reply_markup: this.mainReplyKeyboard() },
    );
  }

  private async sendOpenWebLinkFallback(ctx: Context, telegramId: string) {
    try {
      const url = await this.authService.createBotWebLoginUrl(telegramId);
      await ctx.reply(`🌐 Open Web (avtomatik kirish):\n${url}`);
    } catch (err) {
      this.logger.warn(
        `sendOpenWebLinkFallback: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await ctx.reply(`🌐 Sayt: ${this.frontendUrl}/login`);
    }
  }

  private phoneRequestKeyboard() {
    return new Keyboard()
      .requestContact(BTN_SHARE_PHONE)
      .resized()
      .persistent();
  }

  private isHttpsUrl(url: string): boolean {
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** BotFather «Open» / chat menu button → Mini App */
  private async syncMiniAppMenuButton() {
    if (!this.bot || !this.isHttpsUrl(this.miniAppUrl)) return;
    try {
      await this.bot.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Mini App',
          web_app: { url: this.miniAppUrl },
        },
      });
      this.logger.log(`Telegram menu button → ${this.miniAppUrl}`);
    } catch (err) {
      this.logger.warn(
        `setChatMenuButton: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private mainReplyKeyboard() {
    return new Keyboard()
      .text(BTN_MY_ORDERS)
      .text(BTN_SEND_CODE)
      .row()
      .text(BTN_OPEN_WEB)
      .webApp(BTN_MINI_APP, this.miniAppUrl || DEFAULT_MINI_APP_URL)
      .resized()
      .persistent();
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
