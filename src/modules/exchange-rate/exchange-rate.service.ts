import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { parseCbuUsdPayload } from './cbu-usd.parser';
import type { ExchangeRate } from './exchange-rate.types';

const CBU_USD_URL = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/';
const CACHE_KEY = 'fx:usd-uzs';
const LAST_KEY = 'fx:usd-uzs:last';
const CACHE_TTL_SECONDS = 3600;
const MEMORY_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private memory: { value: ExchangeRate; expiresAt: number } | null = null;

  constructor(private readonly redis: RedisService) {}

  async getUsdToUzs(): Promise<ExchangeRate> {
    if (this.memory && this.memory.expiresAt > Date.now()) {
      return this.memory.value;
    }

    const cached = await this.redis.getJson<ExchangeRate>(CACHE_KEY);
    if (cached && cached.usdToUzs > 0) {
      this.remember(cached);
      return cached;
    }

    try {
      const fresh = await this.fetchCbu();
      await this.redis.setJson(CACHE_KEY, fresh, CACHE_TTL_SECONDS);
      await this.redis.setJson(LAST_KEY, fresh);
      this.remember(fresh);
      return fresh;
    } catch (err) {
      this.logger.warn(
        `CBU fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const last = await this.redis.getJson<ExchangeRate>(LAST_KEY);
      if (last && last.usdToUzs > 0) {
        this.remember(last);
        return last;
      }
      throw new ServiceUnavailableException('Dollar kursi olinmadi');
    }
  }

  async getRate(): Promise<number> {
    const { usdToUzs } = await this.getUsdToUzs();
    return usdToUzs;
  }

  private remember(value: ExchangeRate) {
    this.memory = { value, expiresAt: Date.now() + MEMORY_TTL_MS };
  }

  private async fetchCbu(): Promise<ExchangeRate> {
    const response = await fetch(CBU_USD_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'sami-ecommerce/1.0',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`CBU HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    return parseCbuUsdPayload(data);
  }
}
