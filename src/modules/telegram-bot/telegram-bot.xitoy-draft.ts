export const XITOY_DRAFT_KEY_PREFIX = 'telegram:xitoy-draft:';
export const XITOY_DRAFT_TTL_SEC = 30 * 60;

export type YuanRateUnit = 'yuan' | 'usd';

export type XitoyDraftStep =
  | 'image'
  | 'name'
  | 'yuanRateUnit'
  | 'chinaPriceYuan'
  | 'cubicM3'
  | 'weightKg'
  | 'yuanRate'
  | 'customsFee';

export type XitoyDraftData = {
  step: XitoyDraftStep;
  imageUrl?: string;
  name?: string;
  yuanRateUnit?: YuanRateUnit;
  chinaPriceYuan?: number;
  cubicM3?: number;
  weightKg?: number;
  yuanRate?: number;
  customsFee?: number;
};

export const xitoyYuanRateUnitPrompt =
  '💱 Hisob-kitob qaysi valyutada?\n\n• Yuanda — xitoy narxi ¥ da, dollarga o‘giriladi\n• Dollarda — xitoy narxi $ da, to‘g‘ridan-to‘g‘ri $ da hisoblanadi';

export function xitoyChinaPricePrompt(unit: YuanRateUnit): string {
  if (unit === 'yuan') {
    return '🇨🇳 Xitoy narxi (yuan) — raqam kiriting.';
  }
  return '🇺🇸 Xitoy narxi (dollar) — raqam kiriting.';
}

export const xitoyStepPrompts: Record<
  Exclude<XitoyDraftStep, 'yuanRateUnit' | 'chinaPriceYuan'>,
  string
> = {
  image: '📷 Tovar rasmini yuboring.',
  name: '📝 Tovar nomini yozing.',
  cubicM3: '📦 Kubi (m³) — raqam kiriting.',
  weightKg: '⚖️ Og‘irlik (kg) — raqam kiriting.',
  yuanRate: '💱 1 $ necha ¥? (masalan: 6,7)',
  customsFee: '🛃 Rastamoshka stavkasi — raqam kiriting.',
};

const stepOrder: XitoyDraftStep[] = [
  'image',
  'name',
  'yuanRateUnit',
  'chinaPriceYuan',
  'cubicM3',
  'weightKg',
  'yuanRate',
  'customsFee',
];

export function nextXitoyStep(
  current: XitoyDraftStep,
  unit?: YuanRateUnit,
): XitoyDraftStep | null {
  const idx = stepOrder.indexOf(current);
  if (idx < 0 || idx >= stepOrder.length - 1) return null;

  let next = stepOrder[idx + 1];

  if (next === 'yuanRate' && unit === 'usd') {
    const yuanRateIdx = stepOrder.indexOf('yuanRate');
    if (yuanRateIdx < 0 || yuanRateIdx >= stepOrder.length - 1) return null;
    next = stepOrder[yuanRateIdx + 1];
  }

  return next;
}

export function parsePositiveNumber(text: string): number | null {
  const normalized = text.replace(/\s/g, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function getXitoyStepPrompt(
  step: XitoyDraftStep,
  unit?: YuanRateUnit,
): string {
  if (step === 'yuanRateUnit') {
    return xitoyYuanRateUnitPrompt;
  }
  if (step === 'chinaPriceYuan') {
    return unit ? xitoyChinaPricePrompt(unit) : '🇨🇳 Xitoy narxi — raqam kiriting.';
  }
  return xitoyStepPrompts[step];
}

export function xitoyDraftKey(telegramId: string | number): string {
  return `${XITOY_DRAFT_KEY_PREFIX}${telegramId}`;
}
