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

export default () => ({
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  port: parseInt(optionalEnv('PORT', '4000'), 10),
  apiPrefix: optionalEnv('API_PREFIX', 'api/v1'),

  /** API o'zining to'liq base URL i (masalan http://localhost:4000) */
  appUrl: requireEnv('APP_URL').replace(/\/$/, ''),

  /** Asosiy frontend URL (CORS va redirectlar uchun) */
  frontendUrl: requireEnv('FRONTEND_URL').replace(/\/$/, ''),

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

  telegram: {
    botToken: optionalEnv('TELEGRAM_BOT_TOKEN'),
    gatewayToken: optionalEnv('TELEGRAM_GATEWAY_TOKEN'),
    gatewayUrl: requireEnv('TELEGRAM_GATEWAY_URL').replace(/\/$/, ''),
    gatewayMock: process.env.GATEWAY_MOCK === 'true',
    gatewayMockCode: optionalEnv('GATEWAY_MOCK_CODE', '123456'),
    otpTtlSeconds: parseInt(optionalEnv('OTP_TTL_SECONDS', '120'), 10),
    otpCooldownSeconds: parseInt(optionalEnv('OTP_COOLDOWN_SECONDS', '60'), 10),
    otpDailyLimit: parseInt(optionalEnv('OTP_DAILY_LIMIT', '10'), 10),
    initDataMaxAgeSeconds: parseInt(
      optionalEnv('TELEGRAM_INITDATA_MAX_AGE_SECONDS', '86400'),
      10,
    ),
    superAdminPhone: optionalEnv('SUPER_ADMIN_PHONE'),
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
});
