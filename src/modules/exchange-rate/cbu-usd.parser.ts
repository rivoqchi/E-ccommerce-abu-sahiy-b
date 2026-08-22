import type { ExchangeRate } from './exchange-rate.types';

export function parseCbuUsdPayload(data: unknown): ExchangeRate {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new Error("CBU javobi noto'g'ri");
  }

  const rec = row as Record<string, unknown>;
  const raw = rec.Rate ?? rec.rate;
  const rate = Number(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("CBU kursi noto'g'ri");
  }

  const date = String(rec.Date ?? rec.date ?? '').trim();
  return { usdToUzs: rate, date, source: 'cbu' };
}
