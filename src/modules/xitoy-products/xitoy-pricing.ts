export type XitoyPricingInput = {
  chinaPriceYuan: number;
  cubicM3: number;
  weightKg: number;
  yuanRate: number;
  customsFee: number;
};

export type XitoyPricingResult = {
  /** Xitoy narxi dollarda (yuan / kurs) */
  priceUsd: number;
  /** Logistika: kubi × 100 */
  logisticsUsd: number;
  /** Rastamoshka: kg × stavka */
  customsUsd: number;
  /** Tan narxi dollarda */
  costPriceUsd: number;
  /** Tan narxi yuanda */
  costPriceYuan: number;
};

export function calculateXitoyCostPrice(
  input: XitoyPricingInput,
): XitoyPricingResult {
  const { chinaPriceYuan, cubicM3, weightKg, yuanRate, customsFee } = input;

  const priceUsd = yuanRate > 0 ? chinaPriceYuan / yuanRate : 0;
  const logisticsUsd = cubicM3 * 100;
  const customsUsd = weightKg * customsFee;
  const costPriceUsd = priceUsd + logisticsUsd + customsUsd;
  const costPriceYuan = costPriceUsd * yuanRate;

  return {
    priceUsd,
    logisticsUsd,
    customsUsd,
    costPriceUsd,
    costPriceYuan,
  };
}
