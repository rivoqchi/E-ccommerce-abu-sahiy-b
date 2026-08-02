import { PriceTier } from '../enums/price-tier.enum';

export type PricedProduct = {
  price: number;
  wholesalePrice?: number;
};

/** Resolve unit price from user tier. Guests / retail → oddiy narx. */
export function resolveUnitPrice(
  product: PricedProduct,
  tier: PriceTier | string | null | undefined = PriceTier.Retail,
): number {
  const retail = Number(product.price) || 0;
  if (tier === PriceTier.Wholesale) {
    const wholesale = Number(product.wholesalePrice);
    if (Number.isFinite(wholesale) && wholesale >= 0) {
      return wholesale;
    }
  }
  return retail;
}
