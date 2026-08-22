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
