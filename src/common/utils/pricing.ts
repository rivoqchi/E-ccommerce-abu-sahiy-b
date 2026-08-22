import { PriceTier } from '../enums/price-tier.enum';

export type PricedProduct = {
  price: number;
  wholesalePrice?: number;
};

/** Oddiy (retail) narx ustamasi — optom USD dan so‘mga o‘tkazishda. */
export const RETAIL_MARKUP = 0.1;

export const FREE_SHIPPING_USD = 100;
export const SHIPPING_FEE_USD = 5;

export function isWholesaleTier(
  tier: PriceTier | string | null | undefined,
): boolean {
  return tier === PriceTier.Wholesale || tier === 'wholesale';
}

/** Optom USD; yo‘q yoki 0 bo‘lsa oddiy USD. */
export function sourceUsd(product: PricedProduct): number {
  const wholesale = Number(product.wholesalePrice);
  if (Number.isFinite(wholesale) && wholesale > 0) return wholesale;
  return Number(product.price) || 0;
}

export function usdToUzs(
  usd: number,
  rate: number,
  markup = 0,
): number {
  if (!Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) {
    return Number.NaN;
  }
  return Math.round(usd * rate * (1 + markup));
}

/**
 * Optom mijoz → USD (o‘zgarmagan).
 * Oddiy / mehmon → so‘m, +10%.
 */
export function resolveUnitPrice(
  product: PricedProduct,
  tier: PriceTier | string | null | undefined = PriceTier.Retail,
  usdToUzsRate = 0,
): number {
  const usd = sourceUsd(product);
  if (isWholesaleTier(tier)) return usd;
  return usdToUzs(usd, usdToUzsRate, RETAIL_MARKUP);
}

export function resolveCompareAtUzs(
  compareAtUsd: number,
  usdToUzsRate: number,
): number {
  return usdToUzs(compareAtUsd, usdToUzsRate, RETAIL_MARKUP);
}

export function shippingFeeUzs(
  subtotalUzs: number,
  usdToUzsRate: number,
): number {
  const threshold = usdToUzs(FREE_SHIPPING_USD, usdToUzsRate);
  const fee = usdToUzs(SHIPPING_FEE_USD, usdToUzsRate);
  if (!Number.isFinite(threshold) || !Number.isFinite(fee)) return 0;
  return subtotalUzs >= threshold ? 0 : fee;
}

export function shippingFeeForTier(
  subtotal: number,
  usdToUzsRate: number,
  tier: PriceTier | string | null | undefined,
): number {
  if (isWholesaleTier(tier)) {
    return subtotal >= FREE_SHIPPING_USD ? 0 : SHIPPING_FEE_USD;
  }
  return shippingFeeUzs(subtotal, usdToUzsRate);
}

export function orderCurrency(
  tier: PriceTier | string | null | undefined,
): 'USD' | 'UZS' {
  return isWholesaleTier(tier) ? 'USD' : 'UZS';
}
