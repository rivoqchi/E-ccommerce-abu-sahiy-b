import { PriceTier } from '../enums/price-tier.enum';
import {
  resolveCompareAtUzs,
  resolveUnitPrice,
  shippingFeeForTier,
  shippingFeeUzs,
  sourceUsd,
  usdToUzs,
} from './pricing';

describe('pricing', () => {
  const rate = 12_000;
  const product = { price: 10, wholesalePrice: 8 };

  it('sourceUsd prefers wholesale when > 0', () => {
    expect(sourceUsd(product)).toBe(8);
    expect(sourceUsd({ price: 10, wholesalePrice: 0 })).toBe(10);
    expect(sourceUsd({ price: 10 })).toBe(10);
  });

  it('retail adds 10% then converts to so\'m', () => {
    expect(resolveUnitPrice(product, PriceTier.Retail, rate)).toBe(106_000);
  });

  it('rounds so\'m to the nearest thousand', () => {
    expect(usdToUzs(1, 234_574)).toBe(235_000);
    expect(usdToUzs(1, 234_400)).toBe(234_000);
  });

  it('wholesale stays in USD', () => {
    expect(resolveUnitPrice(product, PriceTier.Wholesale, rate)).toBe(8);
  });

  it('compare-at uses retail markup', () => {
    expect(resolveCompareAtUzs(10, rate)).toBe(Math.round(10 * 12_000 * 1.1));
  });

  it('returns NaN without a valid rate', () => {
    expect(Number.isNaN(usdToUzs(8, 0))).toBe(true);
    expect(Number.isNaN(resolveUnitPrice(product, PriceTier.Retail, 0))).toBe(
      true,
    );
  });

  it('converts free-shipping threshold and fee from USD', () => {
    const under = shippingFeeUzs(1_000_000, rate);
    const over = shippingFeeUzs(1_200_000, rate);
    expect(under).toBe(5 * 12_000);
    expect(over).toBe(0);
  });

  it('wholesale shipping stays in USD', () => {
    expect(shippingFeeForTier(50, rate, PriceTier.Wholesale)).toBe(5);
    expect(shippingFeeForTier(100, rate, PriceTier.Wholesale)).toBe(0);
  });
});
