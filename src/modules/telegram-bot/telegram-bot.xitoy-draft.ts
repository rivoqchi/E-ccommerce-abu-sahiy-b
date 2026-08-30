export const XITOY_DRAFT_KEY_PREFIX = 'telegram:xitoy-draft:';
export const XITOY_DRAFT_TTL_SEC = 30 * 60;

export type XitoyDraftStep =
  | 'image'
  | 'name'
  | 'chinaPriceYuan'
  | 'cubicM3'
  | 'weightKg'
  | 'yuanRate'
  | 'customsFee';

export type XitoyDraftData = {
  step: XitoyDraftStep;
  imageUrl?: string;
  name?: string;
  chinaPriceYuan?: number;
  cubicM3?: number;
  weightKg?: number;
  yuanRate?: number;
  customsFee?: number;
};

export const xitoyStepPrompts: Record<XitoyDraftStep, string> = {
  image: '📷 Tovar rasmini yuboring.',
  name: '📝 Tovar nomini yozing.',
  chinaPriceYuan: '🇨🇳 Xitoy narxi (yuan) — raqam kiriting.',
  cubicM3: '📦 Kubi (m³) — raqam kiriting.',
  weightKg: '⚖️ Og‘irlik (kg) — raqam kiriting.',
  yuanRate: '💱 Yuan kursi — raqam kiriting.',
  customsFee: '🛃 Rastamoshka stavkasi — raqam kiriting.',
};

export function nextXitoyStep(current: XitoyDraftStep): XitoyDraftStep | null {
  const order: XitoyDraftStep[] = [
    'image',
    'name',
    'chinaPriceYuan',
    'cubicM3',
    'weightKg',
    'yuanRate',
    'customsFee',
  ];
  const idx = order.indexOf(current);
  if (idx < 0 || idx >= order.length - 1) return null;
  return order[idx + 1];
}

export function parsePositiveNumber(text: string): number | null {
  const normalized = text.replace(/\s/g, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function xitoyDraftKey(telegramId: string | number): string {
  return `${XITOY_DRAFT_KEY_PREFIX}${telegramId}`;
}
