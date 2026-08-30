import { calculateXitoyCostPrice } from './xitoy-pricing';

describe('calculateXitoyCostPrice', () => {
  it('matches spreadsheet example (kasrulka)', () => {
    const result = calculateXitoyCostPrice({
      chinaPriceYuan: 30,
      cubicM3: 0.0029,
      weightKg: 1.625,
      yuanRate: 6.7,
      customsFee: 0.5,
    });

    expect(result.priceUsd).toBeCloseTo(30 / 6.7, 8);
    expect(result.logisticsUsd).toBeCloseTo(0.29, 8);
    expect(result.customsUsd).toBeCloseTo(0.8125, 8);
    expect(result.costPriceUsd).toBeCloseTo(30 / 6.7 + 0.29 + 0.8125, 8);
    expect(result.costPriceYuan).toBeCloseTo(result.costPriceUsd * 6.7, 8);
  });

  it('returns zeros when yuan rate is zero', () => {
    const result = calculateXitoyCostPrice({
      chinaPriceYuan: 30,
      cubicM3: 0.0029,
      weightKg: 1.625,
      yuanRate: 0,
      customsFee: 0.5,
    });

    expect(result.priceUsd).toBe(0);
    expect(result.costPriceYuan).toBe(0);
    expect(result.logisticsUsd).toBeCloseTo(0.29, 8);
    expect(result.customsUsd).toBeCloseTo(0.8125, 8);
  });
});
