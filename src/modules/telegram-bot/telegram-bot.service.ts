import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'fs';
import { join } from 'path';
import { Bot, InlineKeyboard, Keyboard, Context, InputFile } from 'grammy';
import type { Update } from 'grammy/types';
import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { UsersService } from '../users/users.service';
import { OrdersService } from '../orders/orders.service';
import { AuthService } from '../auth/auth.service';
import { RedisService } from '../redis/redis.service';
import { ProductsService } from '../products/products.service';
import { UploadsService } from '../uploads/uploads.service';
import { XitoyProductsService } from '../xitoy-products/xitoy-products.service';
import { UserDocument } from '../users/schemas/user.schema';
import { Role } from '../../common/enums/role.enum';
import { onOrderCreated } from '../orders/order-events';
import {
  ApprovalStatus,
  resolveApprovalStatus,
} from '../../common/enums/approval-status.enum';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  BTN_MINI_APP,
  BTN_MY_ORDERS,
  BTN_OPEN_WEB,
  BTN_SEND_CODE,
  BTN_SHARE_PHONE,
  BTN_XITOY,
  statusLabels,
  texts,
} from './telegram-bot.texts';
import {
  nextXitoyStep,
  parsePositiveNumber,
  type XitoyDraftData,
  type XitoyDraftStep,
  type YuanRateUnit,
  xitoyDraftKey,
  xitoyStepPrompts,
  xitoyChinaPricePrompt,
  xitoyYuanRateUnitPrompt,
  XITOY_DRAFT_TTL_SEC,
} from './telegram-bot.xitoy-draft';

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
  private pendingUpdates: Update[] = [];
  private stopOrderCreatedListener: (() => void) | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
    private readonly authService: AuthService,
    private readonly redisService: RedisService,
    private readonly productsService: ProductsService,
    private readonly uploadsService: UploadsService,
    private readonly xitoyProductsService: XitoyProductsService,
  ) {}

  async onModuleInit() {
    this.stopOrderCreatedListener = onOrderCreated((orderId) => {
      void this.notifyAdminsOfNewOrder(orderId);
    });

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
      const mode = this.resolveMode();
      this.mode = mode;

      // Faqat lokal API: Mini App Vercel'da bo'lsa getUpdates ni Render'ga qoldiramiz.
      // Render o'zi hech qachon skip qilmasin — aks holda /start javobsiz qoladi.
      if (
        !this.isHostedOnRender() &&
        (mode === 'off' || this.shouldYieldTelegramToProduction())
      ) {
        this.logger.warn(
          `Telegram polling skip (local): Mini App ${this.miniAppUrl}. ` +
            `Bot Render webhook orqali ishlaydi.`,
        );
        this.mode = 'off';
        return;
      }

      if (mode === 'off') {
        this.mode = 'off';
        return;
      }

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
      this.logger.log(
        `Telegram bot bootstrap (${mode}), Mini App: ${this.miniAppUrl}`,
      );
      await this.startBotWithRetry(this.bot, mode);
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
          await bot.init();
          this.logger.log(
            `Telegram init ok (@${bot.botInfo.username ?? 'unknown'})`,
          );
          await bot.api.setWebhook(webhookUrl, {
            secret_token: secret,
            drop_pending_updates: false,
          });
          this.mode = 'webhook';
          this.logger.log(`Telegram bot webhook: ${webhookUrl}`);
          await this.flushPendingUpdates();
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
    void (async () => {
      try {
        // Oldingi loop hali yopilmagan bo‘lsa — o‘zimiz bilan 409 chiqadi
        try {
          await bot.stop();
        } catch {
          /* already stopped */
        }
        await bot.start({
          drop_pending_updates: true,
          onStart: (info) => {
            this.logger.log(`Telegram bot ready (@${info.username})`);
          },
        });
      } catch (err: unknown) {
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
      }
    })();
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
    this.stopOrderCreatedListener?.();
    this.stopOrderCreatedListener = null;
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
    return this.bot != null && Boolean(this.bot.botInfo);
  }

  getWebhookSecret(): string {
    return (
      this.configService.get<string>('telegram.botWebhookSecret')?.trim() || ''
    );
  }

  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot?.botInfo) {
      if (this.pendingUpdates.length < 100) {
        this.pendingUpdates.push(update);
      }
      return;
    }
    try {
      await this.bot.handleUpdate(update);
    } catch (err) {
      this.logger.error(
        `Webhook handleUpdate: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async flushPendingUpdates() {
    const bot = this.bot;
    if (!bot?.botInfo) return;
    const queued = this.pendingUpdates.splice(0);
    for (const update of queued) {
      try {
        await bot.handleUpdate(update);
      } catch (err) {
        this.logger.warn(
          `pending webhook: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private isHostedOnRender(): boolean {
    if (process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL) {
      return true;
    }
    const appUrl = this.configService.get<string>('appUrl') || '';
    return appUrl.includes('onrender.com');
  }

  private resolveMode(): 'polling' | 'webhook' | 'off' {
    const configured = this.configService
      .get<string>('telegram.botMode')
      ?.trim()
      .toLowerCase();

    // Render: TELEGRAM_BOT_MODE=off/polling bo'lsa ham webhook — /start ishlashi uchun
    if (this.isHostedOnRender()) {
      return 'webhook';
    }

    if (configured === 'off') return 'off';

    const nodeEnv =
      this.configService.get<string>('nodeEnv')?.toLowerCase() ?? 'development';
    if (nodeEnv === 'production') {
      return 'webhook';
    }
    if (configured === 'webhook' || configured === 'polling') {
      return configured;
    }
    return 'polling';
  }

  /** Lokal mashina polling qilmasin — Mini App Render API ni ishlatadi */
  private shouldYieldTelegramToProduction(): boolean {
    if (this.isHostedOnRender()) return false;
    const appUrl = this.configService.get<string>('appUrl') || '';
    try {
      const host = new URL(appUrl).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') return false;
    } catch {
      return false;
    }
    return this.isHttpsUrl(this.miniAppUrl);
  }

  private registerHandlers(bot: Bot) {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.on('message:contact', (ctx) => this.onContact(ctx));
    bot.hears(BTN_MY_ORDERS, (ctx) => this.onMyOrders(ctx));
    bot.hears(BTN_SEND_CODE, (ctx) => this.onSendCode(ctx));
    bot.hears(BTN_OPEN_WEB, (ctx) => this.onOpenWebText(ctx));
    bot.hears(BTN_MINI_APP, (ctx) => this.onMiniAppText(ctx));
    bot.hears(BTN_XITOY, (ctx) => this.onXitoyButton(ctx));
    bot.command('bekor', (ctx) => this.onXitoyCancel(ctx));
    bot.on('message:photo', (ctx) => this.onPhotoMessage(ctx));
    bot.callbackQuery('open_web', (ctx) => this.onOpenWebCallback(ctx));
    bot.callbackQuery('send_code', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await this.onSendCode(ctx);
    });
    bot.callbackQuery('mini_app', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await this.onMiniAppText(ctx);
    });
    bot.callbackQuery(/^approve:(.+)$/, (ctx) =>
      this.onApprovalCallback(ctx, 'approve'),
    );
    bot.callbackQuery(/^block:(.+)$/, (ctx) =>
      this.onApprovalCallback(ctx, 'block'),
    );
    bot.callbackQuery(/^excel_seen:(.+)$/, (ctx) =>
      this.onExcelSeenCallback(ctx),
    );
    bot.callbackQuery(/^xitoy_rate_unit:(yuan|usd)$/, (ctx) =>
      this.onXitoyRateUnitCallback(ctx),
    );
    bot.on('message:text', (ctx) => this.onFallbackText(ctx));
  }

  private async onStart(ctx: Context) {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (payload === 'xitoy_add') {
      await this.startXitoyDraft(ctx);
      return;
    }

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (user?.phone) {
      await this.replyByAccess(ctx, user);
      return;
    }

    await this.sendRegisterGuide(ctx);
  }

  private registerGuidePhotoPaths(): string[] {
    const names = ['register-step-1.png', 'register-step-2.png'] as const;
    const dirs = [
      join(__dirname, 'assets'),
      join(process.cwd(), 'src', 'modules', 'telegram-bot', 'assets'),
      join(process.cwd(), 'dist', 'modules', 'telegram-bot', 'assets'),
    ];
    const dir =
      dirs.find((candidate) =>
        names.every((name) => existsSync(join(candidate, name))),
      ) ?? dirs[0];
    return names.map((name) => join(dir, name));
  }

  /** /start: yo‘riqnoma rasmlari + telefon so‘rash tugmasi */
  private async sendRegisterGuide(ctx: Context) {
    const paths = this.registerGuidePhotoPaths();
    if (paths.every((file) => existsSync(file))) {
      try {
        await ctx.replyWithMediaGroup([
          {
            type: 'photo',
            media: new InputFile(paths[0]),
            caption: texts.registerGuideCaption,
          },
          {
            type: 'photo',
            media: new InputFile(paths[1]),
          },
        ]);
      } catch (err) {
        this.logger.warn(
          `register guide photos: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      this.logger.warn(`register guide photos missing: ${paths.join(', ')}`);
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

    let user: UserDocument | null = null;
    try {
      user = await this.usersService.registerFromBotContact({
        telegramId: String(from.id),
        phone: contact.phone_number,
        firstName: contact.first_name || from.first_name,
        lastName: contact.last_name || from.last_name,
        username: from.username,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // E11000: user allaqachon bor — ro‘yxatdan o‘tgan deb hisoblaymiz
      if (detail.includes('E11000') || detail.includes('duplicate key')) {
        const existing = await this.usersService.findByTelegramId(
          String(from.id),
        );
        if (existing?.phone) {
          this.logger.warn(
            `registerFromBotContact duplicate ignored telegramId=${from.id}`,
          );
          if (this.usersService.needsApprovalNotify(existing)) {
            await this.notifyAdminsOfPendingUser(existing._id.toString());
          }
          await this.replyByAccess(ctx, existing);
          return;
        }
      }
      const status =
        err instanceof HttpException ? err.getStatus() : undefined;
      if (status === 409) {
        await ctx.reply(texts.phoneConflict, {
          reply_markup: this.phoneRequestKeyboard(),
        });
        return;
      }
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

    if (!user) {
      await ctx.reply(texts.registerFailed, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return;
    }
    if (this.usersService.needsApprovalNotify(user)) {
      await this.notifyAdminsOfPendingUser(user._id.toString());
    }
    await this.replyByAccess(ctx, user, { justRegistered: true });
  }

  private async onMyOrders(ctx: Context) {
    const user = await this.requireApprovedUser(ctx);
    if (!user) return;

    const orders = await this.ordersService.findMine(user._id.toString());
    const recent = orders.slice(0, 10);

    if (!recent.length) {
      await this.replyWithMenu(ctx, texts.noOrders, false);
      return;
    }

    const hidePrice = (
      await this.productsService.getDisplaySettings()
    ).hiddenFields.includes('price');

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
          .map((i) => {
            const status = String(i.fulfillmentStatus ?? '');
            const given =
              status === 'unavailable'
                ? 0
                : typeof i.givenQuantity === 'number'
                  ? i.givenQuantity
                  : i.quantity;
            const subs = (i.substitutes ?? [])
              .map((s) => `${s.name} ×${s.quantity}`)
              .join(', ');
            if (status === 'unavailable' || given === 0) {
              return `• ${i.name} ×${i.quantity} (qolmagan)${subs ? ` → ${subs}` : ''}`;
            }
            if (given !== i.quantity) {
              return `• ${i.name} ×${given}/${i.quantity}${subs ? ` → ${subs}` : ''}`;
            }
            return `• ${i.name} ×${i.quantity}${subs ? ` → ${subs}` : ''}`;
          })
          .join('\n');
        const more =
          (order.items?.length ?? 0) > 3
            ? `\n• … +${order.items.length - 3}`
            : '';
        return [
          `${index + 1}) #${id}`,
          `📅 ${date}`,
          `📊 ${status}`,
          hidePrice
            ? '💰 Narxni do\'kon bilan kelishasiz'
            : `💰 ${formatMoney(order.total, (order as { currency?: string }).currency)}`,
          items + more,
        ].join('\n');
      })
      .join('\n\n');

    await this.replyWithMenu(ctx, `${texts.ordersHeader}\n${body}`, false);
  }

  private async onSendCode(ctx: Context) {
    const user = await this.requireApprovedUser(ctx);
    if (!user) return;
    const telegramId = user.telegramId;
    if (!telegramId) return;

    try {
      const { code } = await this.authService.issueBotLoginCode(
        String(telegramId),
      );
      await ctx.reply(texts.codeSent(code), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().copyText('Copy Code', code),
      });
      await ctx.reply('Kodni /login sahifasiga kiriting.', {
        reply_markup: this.mainReplyKeyboard(user.role === Role.Admin),
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
      text === BTN_MINI_APP ||
      text === BTN_XITOY
    ) {
      return;
    }

    const telegramId = ctx.from?.id;
    if (telegramId != null) {
      const draft = await this.getXitoyDraft(String(telegramId));
      if (draft && draft.step !== 'image') {
        const user = await this.requireAdmin(ctx);
        if (!user) return;
        await this.handleXitoyTextStep(ctx, String(telegramId), draft, text);
        return;
      }
    }

    const user = await this.requireApprovedUser(ctx);
    if (!user) return;

    await this.replyWithMenu(ctx, texts.menuHint, false, user);
  }

  /** Pastki reply keyboard — Mini App doim web_app (Telegram ichida ochiladi) */
  private async replyWithMenu(
    ctx: Context,
    message: string,
    _installReplyKeyboard = true,
    user?: UserDocument | null,
  ) {
    let resolvedUser = user;
    if (resolvedUser === undefined && ctx.from?.id) {
      resolvedUser = await this.usersService.findByTelegramId(
        String(ctx.from.id),
      );
    }
    const isAdmin = resolvedUser?.role === Role.Admin;
    try {
      await ctx.reply(message, {
        reply_markup: this.mainReplyKeyboard(isAdmin),
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
    const user = await this.requireApprovedUser(ctx);
    if (!user?.telegramId) return;
    await this.sendOpenWebLinkFallback(ctx, user.telegramId);
  }

  private async onOpenWebCallback(ctx: Context) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const user = await this.requireApprovedUser(ctx);
    if (!user?.telegramId) return;
    await this.sendOpenWebLinkFallback(ctx, user.telegramId);
  }

  private async onMiniAppText(ctx: Context) {
    const user = await this.requireApprovedUser(ctx);
    if (!user) return;
    await ctx.reply(
      'Mini App tugmasini qayta bosing — Telegram ichida ochiladi.',
      {
        reply_markup: this.mainReplyKeyboard(user.role === Role.Admin),
      },
    );
  }

  private async sendOpenWebLinkFallback(ctx: Context, telegramId: string) {
    try {
      const url = await this.authService.createBotWebLoginUrl(telegramId);
      await ctx.reply(
        '🌐 Sayt avtomatik ochiladi — tugmani bosing. Kod kiritish shart emas.',
        {
          reply_markup: new InlineKeyboard().url('Saytga kirish', url),
          link_preview_options: { is_disabled: true },
        },
      );
    } catch (err) {
      this.logger.warn(
        `sendOpenWebLinkFallback: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const site = this.miniAppUrl || this.frontendUrl;
      await ctx.reply(`🌐 Sayt: ${site}/login`);
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

  /** Default chat menu — Mini App faqat tasdiqlangan chatlarga */
  private async syncMiniAppMenuButton() {
    if (!this.bot) return;
    try {
      await this.bot.api.setChatMenuButton({
        menu_button: { type: 'commands' },
      });
      this.logger.log('Telegram default menu button → commands');
    } catch (err) {
      this.logger.warn(
        `setChatMenuButton: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private mainReplyKeyboard(isAdmin = false) {
    const kb = new Keyboard()
      .text(BTN_MY_ORDERS)
      .text(BTN_SEND_CODE)
      .row()
      .text(BTN_OPEN_WEB)
      .webApp(BTN_MINI_APP, this.miniAppUrl || DEFAULT_MINI_APP_URL);
    if (isAdmin) {
      kb.row().text(BTN_XITOY);
    }
    return kb.resized().persistent();
  }

  private async requireApprovedUser(
    ctx: Context,
  ): Promise<UserDocument | null> {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return null;

    const user = await this.usersService.findByTelegramId(String(telegramId));
    if (!user?.phone) {
      await ctx.reply(texts.contactRequired, {
        reply_markup: this.phoneRequestKeyboard(),
      });
      return null;
    }

    const status = resolveApprovalStatus(user);
    if (status === ApprovalStatus.Pending) {
      await this.replyWithoutMenu(ctx, texts.alreadyWaiting);
      await this.setChatMiniAppButton(Number(telegramId), false);
      return null;
    }
    if (status === ApprovalStatus.Blocked) {
      await this.replyWithoutMenu(ctx, texts.blocked);
      await this.setChatMiniAppButton(Number(telegramId), false);
      return null;
    }
    return user;
  }

  private async replyByAccess(
    ctx: Context,
    user: UserDocument,
    opts?: { justRegistered?: boolean },
  ) {
    const telegramId = user.telegramId;
    const status = resolveApprovalStatus(user);
    if (status === ApprovalStatus.Pending) {
      await this.replyWithoutMenu(
        ctx,
        opts?.justRegistered ? texts.waitingApproval : texts.alreadyWaiting,
      );
      if (telegramId) {
        await this.setChatMiniAppButton(Number(telegramId), false);
      }
      return;
    }
    if (status === ApprovalStatus.Blocked) {
      await this.replyWithoutMenu(ctx, texts.blocked);
      if (telegramId) {
        await this.setChatMiniAppButton(Number(telegramId), false);
      }
      return;
    }
    await this.replyWithMenu(
      ctx,
      opts?.justRegistered ? texts.profileApproved : texts.welcomeReady,
      true,
      user,
    );
    if (telegramId) {
      await this.setChatMiniAppButton(Number(telegramId), true);
    }
  }

  private async replyWithoutMenu(ctx: Context, message: string) {
    await ctx.reply(message, {
      reply_markup: { remove_keyboard: true },
    });
  }

  async notifyAdminsOfPendingUser(userId: string): Promise<void> {
    if (!this.bot) return;
    const user = await this.usersService.findById(userId);
    if (!this.usersService.needsApprovalNotify(user)) return;

    const admins = await this.usersService.findAdminsWithTelegram();
    const messages: { chatId: string; messageId: number }[] = [];
    const text = this.formatAdminProfileCard(user);

    for (const admin of admins) {
      if (!admin.telegramId || admin.telegramId === user.telegramId) continue;
      try {
        const sent = await this.bot.api.sendMessage(
          admin.telegramId,
          text,
          { reply_markup: this.approvalKeyboard(user._id.toString()) },
        );
        messages.push({
          chatId: String(sent.chat.id),
          messageId: sent.message_id,
        });
      } catch (err) {
        this.logger.warn(
          `notify admin ${admin.telegramId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (messages.length) {
      await this.usersService.setApprovalNotifyMessages(userId, messages);
    }
  }

  async applyAccessDecision(userId: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    await this.syncAdminApprovalMessages(user);
    await this.notifySubjectOfDecision(user);
  }

  private async onApprovalCallback(
    ctx: Context,
    action: 'approve' | 'block',
  ) {
    const match = ctx.match;
    const userId = Array.isArray(match) ? match[1] : undefined;
    if (!userId || !isMongoId(userId)) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }

    const actorDoc = ctx.from?.id
      ? await this.usersService.findByTelegramId(String(ctx.from.id))
      : null;
    if (!actorDoc || actorDoc.role !== Role.Admin) {
      await ctx
        .answerCallbackQuery({ text: texts.notAdmin, show_alert: true })
        .catch(() => undefined);
      return;
    }

    const target = await this.usersService.findById(userId);
    if (resolveApprovalStatus(target) !== ApprovalStatus.Pending) {
      await ctx
        .answerCallbackQuery({ text: texts.alreadyDecided })
        .catch(() => undefined);
      await this.syncAdminApprovalMessages(target);
      return;
    }

    const actor = this.toAuthActor(actorDoc);
    if (action === 'approve') {
      await this.usersService.approveUser(userId, actor);
    } else {
      await this.usersService.blockUser(userId, actor);
    }

    await ctx
      .answerCallbackQuery({
        text: action === 'approve' ? 'Tasdiqlandi' : 'Bloklandi',
      })
      .catch(() => undefined);
    await this.applyAccessDecision(userId);
  }

  private async syncAdminApprovalMessages(user: UserDocument) {
    if (!this.bot) return;
    const status = resolveApprovalStatus(user);
    let footer = '';
    if (status === ApprovalStatus.Approved && user.approvedByName) {
      footer = texts.approvedBy(user.approvedByName);
    } else if (status === ApprovalStatus.Blocked && user.blockedByName) {
      footer = texts.blockedBy(user.blockedByName);
    }
    const text = this.formatAdminProfileCard(user, footer);

    for (const msg of user.approvalNotifyMessages ?? []) {
      try {
        await this.bot.api.editMessageText(msg.chatId, msg.messageId, text, {
          reply_markup: { inline_keyboard: [] },
        });
      } catch (err) {
        this.logger.warn(
          `edit approval message ${msg.chatId}/${msg.messageId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async notifySubjectOfDecision(user: UserDocument) {
    if (!this.bot || !user.telegramId) return;
    const chatId = Number(user.telegramId);
    if (!Number.isFinite(chatId)) return;

    const status = resolveApprovalStatus(user);
    try {
      if (status === ApprovalStatus.Approved) {
        await this.bot.api.sendMessage(chatId, texts.profileApproved, {
          reply_markup: this.mainReplyKeyboard(user.role === Role.Admin),
        });
        await this.setChatMiniAppButton(chatId, true);
        return;
      }
      if (status === ApprovalStatus.Blocked) {
        await this.bot.api.sendMessage(chatId, texts.blocked, {
          reply_markup: { remove_keyboard: true },
        });
        await this.setChatMiniAppButton(chatId, false);
      }
    } catch (err) {
      this.logger.warn(
        `notify subject ${user.telegramId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async setChatMiniAppButton(chatId: number, enabled: boolean) {
    if (!this.bot || !Number.isFinite(chatId)) return;
    try {
      if (enabled && this.isHttpsUrl(this.miniAppUrl)) {
        await this.bot.api.setChatMenuButton({
          chat_id: chatId,
          menu_button: {
            type: 'web_app',
            text: 'Mini App',
            web_app: { url: this.miniAppUrl },
          },
        });
        return;
      }
      await this.bot.api.setChatMenuButton({
        chat_id: chatId,
        menu_button: { type: 'commands' },
      });
    } catch (err) {
      this.logger.warn(
        `setChatMenuButton chat=${chatId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async notifyAdminsOfNewOrder(orderId: string): Promise<void> {
    if (!this.bot || !isMongoId(orderId)) return;

    let order: Awaited<ReturnType<OrdersService['findById']>>;
    try {
      order = await this.ordersService.findById(orderId, undefined, true);
    } catch (err) {
      this.logger.warn(
        `new-order excel: order ${orderId} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    let customer: UserDocument | null = null;
    try {
      customer = await this.usersService.findById(String(order.userId));
    } catch {
      customer = null;
    }

    const caption = this.formatNewOrderCaption(order, customer, []);
    let excel: { buffer: Buffer; filename: string };
    try {
      excel = await this.ordersService.excelForOrder(orderId);
    } catch (err) {
      this.logger.warn(
        `new-order excel build ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    const admins = await this.usersService.findAdminsWithTelegram();
    const messages: { chatId: string; messageId: number }[] = [];
    const keyboard = this.excelSeenKeyboard(orderId);

    for (const admin of admins) {
      if (!admin.telegramId) continue;
      try {
        const sent = await this.bot.api.sendDocument(
          admin.telegramId,
          new InputFile(excel.buffer, excel.filename),
          { caption, reply_markup: keyboard },
        );
        messages.push({
          chatId: String(sent.chat.id),
          messageId: sent.message_id,
        });
      } catch (err) {
        this.logger.warn(
          `new-order excel admin ${admin.telegramId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (messages.length) {
      await this.ordersService.saveExcelNotifyMessages(orderId, messages);
    }
  }

  private async onExcelSeenCallback(ctx: Context) {
    const match = ctx.match;
    const orderId = Array.isArray(match) ? match[1] : undefined;
    if (!orderId || !isMongoId(orderId)) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }

    const from = ctx.from;
    if (!from) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }

    const actorDoc = await this.usersService.findByTelegramId(String(from.id));
    if (!actorDoc || actorDoc.role !== Role.Admin) {
      await ctx
        .answerCallbackQuery({ text: texts.notAdmin, show_alert: true })
        .catch(() => undefined);
      return;
    }

    const fullName = [from.first_name, from.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || actorDoc.fullName;

    let result: Awaited<ReturnType<OrdersService['markExcelSeen']>>;
    try {
      result = await this.ordersService.markExcelSeen(orderId, {
        telegramId: String(from.id),
        username: from.username || actorDoc.username,
        fullName,
      });
    } catch (err) {
      this.logger.warn(
        `excel_seen ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }

    await ctx
      .answerCallbackQuery({
        text: result.already ? texts.excelSeenAlready : texts.excelSeenOk,
      })
      .catch(() => undefined);

    await this.syncExcelSeenMessages(orderId, result);
  }

  private async syncExcelSeenMessages(
    orderId: string,
    result: Awaited<ReturnType<OrdersService['markExcelSeen']>>,
  ) {
    if (!this.bot || !result.messages.length) return;

    let order: Awaited<ReturnType<OrdersService['findById']>>;
    try {
      order = await this.ordersService.findById(orderId, undefined, true);
    } catch {
      return;
    }

    let customer: UserDocument | null = null;
    try {
      customer = await this.usersService.findById(String(order.userId));
    } catch {
      customer = null;
    }

    const caption = this.formatNewOrderCaption(order, customer, result.seenBy);

    for (const msg of result.messages) {
      const alreadySeen = result.seenBy.some(
        (row) => row.telegramId === msg.chatId,
      );
      try {
        await this.bot.api.editMessageCaption(msg.chatId, msg.messageId, {
          caption,
          reply_markup: alreadySeen
            ? { inline_keyboard: [] }
            : this.excelSeenKeyboard(orderId),
        });
      } catch (err) {
        this.logger.warn(
          `edit excel caption ${msg.chatId}/${msg.messageId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private formatNewOrderCaption(
    order: {
      _id: unknown;
      shippingAddress?: { fullName?: string; phone?: string };
    },
    customer: UserDocument | null,
    seenBy: Array<{ username?: string; fullName?: string }>,
  ) {
    const shortId = String(order._id).slice(-8).toUpperCase();
    const name = order.shippingAddress?.fullName || customer?.fullName || '—';
    const phone = order.shippingAddress?.phone || customer?.phone || '—';
    const telegram = this.formatTelegramProfile(customer);

    const lines = [
      '🛒 Yangi buyurtma',
      '',
      `Raqam: #${shortId}`,
      `Mijoz: ${name}`,
      `Telefon: ${phone}`,
      `Telegram: ${telegram}`,
    ];

    if (seenBy.length) {
      lines.push('', '✅ Ko‘rdi:');
      for (const row of seenBy) {
        const who = row.username
          ? `@${row.username}${row.fullName ? ` (${row.fullName})` : ''}`
          : row.fullName || '—';
        lines.push(`• ${who}`);
      }
    }

    return lines.join('\n').slice(0, 1024);
  }

  private formatTelegramProfile(user: UserDocument | null) {
    if (!user) return '—';
    if (user.username) return `@${user.username}`;
    if (user.telegramId) return `Telegram ID: ${user.telegramId}`;
    return '—';
  }

  private excelSeenKeyboard(orderId: string) {
    return new InlineKeyboard().text("Excelni ko'rdim", `excel_seen:${orderId}`);
  }

  private formatAdminProfileCard(user: UserDocument, footer?: string) {
    const lines = [
      'Yangi profil',
      '',
      `Ism: ${user.fullName || '—'}`,
      `Username: ${user.username ? `@${user.username}` : '—'}`,
      `Telefon: ${user.phone || '—'}`,
    ];
    if (footer) {
      lines.push('', footer);
    }
    return lines.join('\n');
  }

  private approvalKeyboard(userId: string) {
    return new InlineKeyboard()
      .text('Tasdiqlash', `approve:${userId}`)
      .text('Bloklash', `block:${userId}`);
  }

  private toAuthActor(user: UserDocument): AuthUser {
    return {
      userId: user._id.toString(),
      email: user.email ?? null,
      phone: user.phone ?? null,
      telegramId: user.telegramId ?? null,
      role: user.role,
    };
  }

  private async requireAdmin(ctx: Context): Promise<UserDocument | null> {
    const user = await this.requireApprovedUser(ctx);
    if (!user) return null;
    if (user.role !== Role.Admin) {
      await ctx.reply(texts.xitoyAdminOnly);
      return null;
    }
    return user;
  }

  private async getXitoyDraft(
    telegramId: string,
  ): Promise<XitoyDraftData | null> {
    const raw = await this.redisService.get(xitoyDraftKey(telegramId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as XitoyDraftData;
    } catch {
      return null;
    }
  }

  private async saveXitoyDraft(
    telegramId: string,
    draft: XitoyDraftData,
  ): Promise<void> {
    await this.redisService.set(
      xitoyDraftKey(telegramId),
      JSON.stringify(draft),
      XITOY_DRAFT_TTL_SEC,
    );
  }

  private async clearXitoyDraft(telegramId: string): Promise<void> {
    await this.redisService.del(xitoyDraftKey(telegramId));
  }

  private async startXitoyDraft(ctx: Context) {
    const user = await this.requireAdmin(ctx);
    if (!user) return;

    const telegramId = String(ctx.from!.id);
    const draft: XitoyDraftData = { step: 'image' };
    await this.saveXitoyDraft(telegramId, draft);

    await ctx.reply(texts.xitoyStarted, {
      reply_markup: this.mainReplyKeyboard(true),
    });
    await ctx.reply(xitoyStepPrompts.image);
  }

  private async onXitoyButton(ctx: Context) {
    await this.startXitoyDraft(ctx);
  }

  private async onXitoyCancel(ctx: Context) {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const draft = await this.getXitoyDraft(String(telegramId));
    if (!draft) return;

    const user = await this.requireAdmin(ctx);
    if (!user) return;

    await this.clearXitoyDraft(String(telegramId));
    await ctx.reply(texts.xitoyCancelled, {
      reply_markup: this.mainReplyKeyboard(true),
    });
  }

  private async onPhotoMessage(ctx: Context) {
    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const draft = await this.getXitoyDraft(String(telegramId));
    if (!draft || draft.step !== 'image') return;

    const user = await this.requireAdmin(ctx);
    if (!user || !this.bot) return;

    const photos = ctx.message?.photo;
    if (!photos?.length) return;

    const largest = photos[photos.length - 1];
    try {
      const file = await this.bot.api.getFile(largest.file_id);
      if (!file.file_path) {
        await ctx.reply(texts.xitoyPhotoFailed);
        return;
      }

      const token = this.configService.get<string>('telegram.botToken')?.trim();
      if (!token) {
        await ctx.reply(texts.xitoyPhotoFailed);
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        await ctx.reply(texts.xitoyPhotoFailed);
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = file.file_path.toLowerCase().endsWith('.png')
        ? 'png'
        : file.file_path.toLowerCase().endsWith('.webp')
          ? 'webp'
          : 'jpg';
      const imageUrl = await this.uploadsService.saveImageBuffer(
        buffer,
        ext,
        'xitoy',
      );

      const nextStep = nextXitoyStep('image');
      if (!nextStep) return;

      const updated: XitoyDraftData = {
        ...draft,
        imageUrl,
        step: nextStep,
      };
      await this.saveXitoyDraft(String(telegramId), updated);
      await ctx.reply(xitoyStepPrompts[nextStep], {
        reply_markup: this.mainReplyKeyboard(true),
      });
    } catch (err) {
      this.logger.warn(
        `xitoy photo upload: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await ctx.reply(texts.xitoyPhotoFailed);
    }
  }

  private async handleXitoyTextStep(
    ctx: Context,
    telegramId: string,
    draft: XitoyDraftData,
    text: string,
  ) {
    const step = draft.step;
    let updated: XitoyDraftData = { ...draft };

    if (step === 'yuanRateUnit') {
      await this.promptXitoyRateUnit(ctx);
      return;
    }

    if (step === 'name') {
      if (!text.trim()) {
        await ctx.reply(texts.xitoyInvalidName);
        return;
      }
      updated.name = text.trim();
    } else {
      const value = parsePositiveNumber(text);
      if (value == null) {
        await ctx.reply(texts.xitoyInvalidNumber);
        return;
      }
      updated = { ...updated, [step]: value } as XitoyDraftData;
    }

    if (step === 'customsFee') {
      await this.finishXitoyDraft(ctx, telegramId, updated);
      return;
    }

    const nextStep = nextXitoyStep(step, updated.yuanRateUnit);
    if (!nextStep) return;

    updated.step = nextStep;
    await this.saveXitoyDraft(telegramId, updated);

    if (nextStep === 'yuanRateUnit') {
      await this.promptXitoyRateUnit(ctx);
      return;
    }

    if (nextStep === 'chinaPriceYuan' && updated.yuanRateUnit) {
      await ctx.reply(xitoyChinaPricePrompt(updated.yuanRateUnit), {
        reply_markup: this.mainReplyKeyboard(true),
      });
      return;
    }

    if (nextStep === 'yuanRate') {
      await ctx.reply(xitoyStepPrompts.yuanRate, {
        reply_markup: this.mainReplyKeyboard(true),
      });
      return;
    }

    await ctx.reply(xitoyStepPrompts[nextStep], {
      reply_markup: this.mainReplyKeyboard(true),
    });
  }

  private xitoyRateUnitKeyboard() {
    return new InlineKeyboard()
      .text('🇨🇳 Yuanda (¥ → $)', 'xitoy_rate_unit:yuan')
      .row()
      .text('🇺🇸 Dollarda ($ da)', 'xitoy_rate_unit:usd');
  }

  private async promptXitoyRateUnit(ctx: Context) {
    await ctx.reply(xitoyYuanRateUnitPrompt, {
      reply_markup: this.xitoyRateUnitKeyboard(),
    });
  }

  private async onXitoyRateUnitCallback(ctx: Context) {
    await ctx.answerCallbackQuery().catch(() => undefined);

    const telegramId = ctx.from?.id;
    if (telegramId == null) return;

    const user = await this.requireAdmin(ctx);
    if (!user) return;

    const draft = await this.getXitoyDraft(String(telegramId));
    if (!draft || draft.step !== 'yuanRateUnit') return;

    const match = ctx.callbackQuery?.data?.match(/^xitoy_rate_unit:(yuan|usd)$/);
    const unit = match?.[1] as YuanRateUnit | undefined;
    if (!unit) return;

    const updated: XitoyDraftData = {
      ...draft,
      yuanRateUnit: unit,
      step: 'chinaPriceYuan',
    };
    await this.saveXitoyDraft(String(telegramId), updated);

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
      () => undefined,
    );
    await ctx.reply(xitoyChinaPricePrompt(unit), {
      reply_markup: this.mainReplyKeyboard(true),
    });
  }

  private async finishXitoyDraft(
    ctx: Context,
    telegramId: string,
    draft: XitoyDraftData,
  ) {
    if (
      !draft.imageUrl ||
      !draft.name ||
      draft.chinaPriceYuan == null ||
      draft.cubicM3 == null ||
      draft.weightKg == null ||
      !draft.yuanRateUnit ||
      draft.customsFee == null ||
      (draft.yuanRateUnit === 'yuan' && draft.yuanRate == null)
    ) {
      await ctx.reply(texts.xitoyNeedPhoto);
      return;
    }

    try {
      await this.xitoyProductsService.create({
        imageUrl: draft.imageUrl,
        name: draft.name,
        chinaPriceYuan: draft.chinaPriceYuan,
        cubicM3: draft.cubicM3,
        weightKg: draft.weightKg,
        yuanRate: draft.yuanRate ?? 0,
        yuanRateUnit: draft.yuanRateUnit,
        customsFee: draft.customsFee,
      });
      await this.clearXitoyDraft(telegramId);
      await ctx.reply(texts.xitoySuccess(draft.name), {
        reply_markup: this.mainReplyKeyboard(true),
      });
    } catch (err) {
      this.logger.error(
        `finishXitoyDraft failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await ctx.reply(texts.registerFailed);
    }
  }
}

function isMongoId(id: string): boolean {
  return Types.ObjectId.isValid(id) && String(new Types.ObjectId(id)) === id;
}

function formatMoney(amount: number, currency?: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';

  if (currency === 'USD') {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return `$${value}`;
    }
  }

  const rounded = Math.round(Math.abs(value));
  const grouped = rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return value < 0 ? `-${grouped}` : grouped;
}
