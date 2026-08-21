function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Kerakli muhit o'zgaruvchisi topilmadi: ${name}. Backend/.env ni tekshiring.`,
    );
  }
  return value;
}

function optionalEnv(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function stripSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function isLocalHostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Render'da APP_URL localhost qolsa ham webhook to'g'ri URL ga yozilsin */
function resolveAppUrl(): string {
  const explicit = stripSlash(requireEnv('APP_URL'));
  const render = stripSlash(optionalEnv('RENDER_EXTERNAL_URL'));
  const nodeEnv = optionalEnv('NODE_ENV', 'development').toLowerCase();
  if (nodeEnv === 'production') {
    if (render) {
      return render.startsWith('http') ? render : `https://${render}`;
    }
    if (!isLocalHostUrl(explicit)) return explicit;
  }
  return explicit;
}

function resolveOpenWebUrl(frontendUrl: string, miniAppUrl: string): string {
  const explicit = stripSlash(optionalEnv('TELEGRAM_OPEN_WEB_URL'));
  const nodeEnv = optionalEnv('NODE_ENV', 'development').toLowerCase();
  if (explicit && !(nodeEnv === 'production' && isLocalHostUrl(explicit))) {
    return explicit;
  }
  if (nodeEnv === 'production' && miniAppUrl && !isLocalHostUrl(miniAppUrl)) {
    return miniAppUrl;
  }
  return frontendUrl;
}

export default () => {
  const frontendUrl = stripSlash(requireEnv('FRONTEND_URL'));
  const miniAppUrl = stripSlash(optionalEnv('TELEGRAM_MINI_APP_URL'));
  return {
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  port: parseInt(optionalEnv('PORT', '4000'), 10),
  apiPrefix: optionalEnv('API_PREFIX', 'api/v1'),

  /** API o'zining to'liq base URL i (masalan http://localhost:4000) */
  appUrl: resolveAppUrl(),

  /** Asosiy frontend URL (CORS va redirectlar uchun) */
  frontendUrl,

  mongodbUri: requireEnv('MONGODB_URI'),
  redisUrl: requireEnv('REDIS_URL'),

  jwt: {
    secret: requireEnv('JWT_SECRET'),
    refreshSecret: requireEnv('JWT_REFRESH_SECRET'),
    accessExpiresIn: optionalEnv('JWT_ACCESS_EXPIRES_IN', '15m'),
    refreshExpiresIn: optionalEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  /** Ver gul bilan ajratilgan CORS originlar */
  corsOrigin: requireEnv('CORS_ORIGIN'),

  throttle: {
    ttl: parseInt(optionalEnv('THROTTLE_TTL', '60'), 10),
    limit: parseInt(optionalEnv('THROTTLE_LIMIT', '100'), 10),
  },
  cacheTtlSeconds: parseInt(optionalEnv('CACHE_TTL_SECONDS', '60'), 10),
  lowStockThreshold: parseInt(optionalEnv('LOW_STOCK_THRESHOLD', '5'), 10),

  /** Smartup ERP — ombor qoldig‘ini barcode bo‘yicha sync */
  smartup: {
    enabled: process.env.SMARTUP_ENABLED === 'true',
    baseUrl: stripSlash(
      optionalEnv('SMARTUP_BASE_URL', 'https://smartup.online'),
    ),
    inventoryBalancePath: optionalEnv(
      'SMARTUP_INVENTORY_BALANCE_PATH',
      '/b/anor/mxsx/mr/inventory_balance$export',
    ),
    username: optionalEnv('SMARTUP_USERNAME'),
    password: optionalEnv('SMARTUP_PASSWORD'),
    /** Cron expression (default: har 10 daqiqa) */
    syncCron: optionalEnv('SMARTUP_SYNC_CRON', '*/10 * * * *'),
  },

  telegram: {
    botToken: optionalEnv('TELEGRAM_BOT_TOKEN'),
    /** polling | webhook — bo'sh bo'lsa: production=webhook, else=polling */
    botMode: optionalEnv('TELEGRAM_BOT_MODE'),
    botWebhookSecret: optionalEnv('TELEGRAM_BOT_WEBHOOK_SECRET'),
    gatewayToken: optionalEnv('TELEGRAM_GATEWAY_TOKEN'),
    gatewayUrl: requireEnv('TELEGRAM_GATEWAY_URL').replace(/\/$/, ''),
    gatewayMock: process.env.GATEWAY_MOCK === 'true',
    gatewayMockCode: optionalEnv('GATEWAY_MOCK_CODE', '123456'),
    /** Lokal /login: botga yozmasdan shu 6 xonali kod (productionda e'tiborsiz) */
    devLoginCode: optionalEnv('DEV_LOGIN_CODE'),
    otpTtlSeconds: parseInt(optionalEnv('OTP_TTL_SECONDS', '600'), 10),
    otpCooldownSeconds: parseInt(optionalEnv('OTP_COOLDOWN_SECONDS', '600'), 10),
    otpDailyLimit: parseInt(optionalEnv('OTP_DAILY_LIMIT', '10'), 10),
    initDataMaxAgeSeconds: parseInt(
      optionalEnv('TELEGRAM_INITDATA_MAX_AGE_SECONDS', '86400'),
      10,
    ),
    superAdminPhone: optionalEnv('SUPER_ADMIN_PHONE'),
    botUsername: optionalEnv('TELEGRAM_BOT_USERNAME'),
    /** Telegram Mini App HTTPS URL (local FRONTEND_URL emas) */
    miniAppUrl,
    /** Open Web login link — production'da localhost bo'lmasin */
    openWebUrl: resolveOpenWebUrl(frontendUrl, miniAppUrl),
  },

  /** Cloudflare R2 (S3-compatible) media storage */
  r2: {
    accountId: requireEnv('R2_ACCOUNT_ID'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucket: requireEnv('R2_BUCKET_NAME'),
    endpoint: requireEnv('R2_ENDPOINT').replace(/\/$/, ''),
    publicUrl: requireEnv('R2_PUBLIC_URL').replace(/\/$/, ''),
  },
  };
};
