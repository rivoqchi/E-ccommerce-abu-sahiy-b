export const PRODUCT_DISPLAY_FIELDS = [
  'code',
  'description',
  'specs',
  'brand',
  'price',
  'compareAtPrice',
  'buyerCount',
  'rating',
] as const;

export type ProductDisplayField = (typeof PRODUCT_DISPLAY_FIELDS)[number];

export const MAX_HIDDEN_SPEC_LABELS = 300;
export const MAX_SPEC_LABEL_LENGTH = 120;

const ALLOWED = new Set<string>(PRODUCT_DISPLAY_FIELDS);

export function sanitizeHiddenFields(
  fields: unknown,
): ProductDisplayField[] {
  if (!Array.isArray(fields)) return [];
  const unique = new Set<ProductDisplayField>();
  for (const field of fields) {
    if (typeof field === 'string' && ALLOWED.has(field)) {
      unique.add(field as ProductDisplayField);
    }
  }
  return [...unique];
}

export function normalizeSpecLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

export function sanitizeHiddenSpecLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const unique = new Set<string>();
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const normalized = normalizeSpecLabel(label);
    if (!normalized || normalized.length > MAX_SPEC_LABEL_LENGTH) continue;
    unique.add(normalized);
    if (unique.size >= MAX_HIDDEN_SPEC_LABELS) break;
  }
  return [...unique];
}

export function maskStorefrontProduct<T extends Record<string, unknown>>(
  product: T,
  settings: {
    hiddenFields: ProductDisplayField[];
    hiddenSpecLabels: string[];
  },
): T {
  const { hiddenFields, hiddenSpecLabels } = settings;
  if (!hiddenFields.length && !hiddenSpecLabels.length) return product;
  const next: Record<string, unknown> = { ...product };

  if (hiddenFields.includes('code')) {
    delete next.code;
  }
  if (hiddenFields.includes('description')) {
    next.description = '';
  }
  if (hiddenFields.includes('specs')) {
    next.specs = [];
  } else if (hiddenSpecLabels.length && Array.isArray(next.specs)) {
    const hidden = new Set(
      hiddenSpecLabels.map((label) => normalizeSpecLabel(label)),
    );
    next.specs = (
      next.specs as Array<{ label?: string; value?: string }>
    ).filter((spec) => !hidden.has(normalizeSpecLabel(spec.label ?? '')));
  }
  if (hiddenFields.includes('brand')) {
    const brand = next.brandId;
    if (brand && typeof brand === 'object') {
      next.brandId = {
        ...(brand as Record<string, unknown>),
        name: '',
      };
    }
  }
  if (hiddenFields.includes('price')) {
    // Narxni javobdan o‘chirmaymiz — katalog/savat tovarni “tayyor” deb qabul qilishi kerak.
    // Do‘kon UI o‘zi yashiradi. Eski (compare) narx esa chiqmasin.
    delete next.compareAtPrice;
  } else if (hiddenFields.includes('compareAtPrice')) {
    delete next.compareAtPrice;
  }
  if (hiddenFields.includes('buyerCount')) {
    next.buyerCount = 0;
    next.recentBuyers = [];
  }

  return next as T;
}
