import { ProductStatus } from '../../common/enums/product-status.enum';

export const PRODUCT_IMAGE_PLACEHOLDER =
  'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=1200&q=80';

const PLACEHOLDER_PHOTO_ID = 'photo-1556911220-e15b29be8c8f';

/** Unsplash placeholder yoki bo‘sh URL — haqiqiy rasm emas. */
export function isPlaceholderProductImage(url?: string | null): boolean {
  const u = url?.trim();
  if (!u) return true;
  if (u === PRODUCT_IMAGE_PLACEHOLDER) return true;
  if (u.includes(PLACEHOLDER_PHOTO_ID)) return true;
  return false;
}

/** Buyurtma / Excel uchun birinchi haqiqiy rasm. */
export function firstProductImage(
  images?: string[] | null,
): string | undefined {
  const url = (images ?? []).find((u) => !isPlaceholderProductImage(u));
  return url?.trim() || undefined;
}

/** Admin «Muammoli» tab — nom, kod, narx yoki haqiqiy rasm yetishmagan. */
export function incompleteProductMongoFilter(): Record<string, unknown> {
  return {
    $or: [
      { name: { $exists: false } },
      { name: null },
      { name: '' },
      { name: { $regex: /^\s*$/ } },
      { code: { $exists: false } },
      { code: null },
      { code: '' },
      { code: { $regex: /^\s*$/ } },
      { price: { $exists: false } },
      { price: null },
      { price: { $lte: 0 } },
      { images: { $exists: false } },
      { images: null },
      { images: { $size: 0 } },
      { 'images.0': { $exists: false } },
      { 'images.0': '' },
      { 'images.0': null },
      { 'images.0': PRODUCT_IMAGE_PLACEHOLDER },
      { 'images.0': { $regex: PLACEHOLDER_PHOTO_ID } },
    ],
  };
}

/** Do‘kon UI — faqat to‘liq mahsulotlar (nom, kod, narx > 0, haqiqiy rasm). */
export function storefrontReadyMongoFilter(): Record<string, unknown> {
  return {
    $and: [
      { name: { $type: 'string', $regex: /\S/ } },
      { code: { $type: 'string', $regex: /\S/ } },
      { price: { $gt: 0 } },
      { 'images.0': { $type: 'string', $regex: /\S/ } },
      { 'images.0': { $ne: PRODUCT_IMAGE_PLACEHOLDER } },
      { 'images.0': { $not: new RegExp(PLACEHOLDER_PHOTO_ID) } },
    ],
  };
}

export function isStorefrontReadyProduct(product: {
  name?: string | null;
  code?: string | null;
  price?: number | null;
  images?: string[] | null;
  isActive?: boolean;
  status?: string;
}): boolean {
  if (product.isActive === false) return false;
  if (product.status != null && product.status !== ProductStatus.Active) {
    return false;
  }
  if (!product.name?.trim()) return false;
  if (!product.code?.trim()) return false;
  if (product.price == null || Number(product.price) <= 0) return false;
  return !isPlaceholderProductImage(product.images?.[0]);
}
