import {
  calculateXitoyCostPrice,
  yuanPerUsdFromRate,
} from './xitoy-pricing';

describe('calculateXitoyCostPrice', () => {
  it('yuan mode: converts ¥ to $ then calculates tan narx in both currencies', () => {
    const result = calculateXitoyCostPrice({
      chinaPriceYuan: 30,
      cubicM3: 0.0029,
      weightKg: 1.625,
      yuanRate: 6.7,
      yuanRateUnit: 'yuan',
      customsFee: 0.5,
    });

    expect(result.yuanPerUsd).toBeCloseTo(6.7, 8);
    expect(result.priceUsd).toBeCloseTo(30 / 6.7, 8);
    expect(result.logisticsUsd).toBeCloseTo(0.29, 8);
    expect(result.customsUsd).toBeCloseTo(0.8125, 8);
    expect(result.costPriceUsd).toBeCloseTo(30 / 6.7 + 0.29 + 0.8125, 8);
    expect(result.costPriceYuan).toBeCloseTo(result.costPriceUsd! * 6.7, 8);
  });

  it('usd mode: china price already in $, no ¥ conversion', () => {
    const chinaPriceUsd = 4.47761194;
    const result = calculateXitoyCostPrice({
      chinaPriceYuan: chinaPriceUsd,
      cubicM3: 0.0029,
      weightKg: 1.625,
      yuanRate: 0,
      yuanRateUnit: 'usd',
      customsFee: 0.5,
    });

    expect(result.yuanPerUsd).toBeNull();
    expect(result.priceUsd).toBeCloseTo(chinaPriceUsd, 8);
    expect(result.costPriceUsd).toBeCloseTo(chinaPriceUsd + 0.29 + 0.8125, 8);
    expect(result.costPriceYuan).toBeNull();
  });

  it('yuan mode returns null yuan total when rate is zero', () => {
    const result = calculateXitoyCostPrice({
      chinaPriceYuan: 30,
      cubicM3: 0.0029,
      weightKg: 1.625,
      yuanRate: 0,
      yuanRateUnit: 'yuan',
      customsFee: 0.5,
    });

    expect(result.priceUsd).toBe(0);
    expect(result.costPriceYuan).toBeNull();
  });
});

describe('yuanPerUsdFromRate', () => {
  it('converts usd-per-yuan to yuan-per-usd', () => {
    expect(yuanPerUsdFromRate(0.149253731, 'usd')).toBeCloseTo(6.7, 4);
  });
});
