/** Bosh sahifa «Yangi mahsulotlar» — switch yoqilganda shu kunlar soni. */
export const NEW_HIGHLIGHT_DAYS = 30;

export function newHighlightUntilFromNow(
  now = new Date(),
  days = NEW_HIGHLIGHT_DAYS,
): Date {
  const until = new Date(now);
  until.setDate(until.getDate() + days);
  return until;
}

export function isNewHighlightActive(
  until?: Date | string | null,
  now = new Date(),
): boolean {
  if (!until) return false;
  const end = until instanceof Date ? until : new Date(until);
  if (Number.isNaN(end.getTime())) return false;
  return end.getTime() > now.getTime();
}
