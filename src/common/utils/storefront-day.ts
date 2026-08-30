/** O‘zbekiston vaqti (Asia/Tashkent) bo‘yicha bugunning 00:00 dan keyingi Date. */
export function startOfTodayInTashkent(now = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) {
    const utc = new Date(now);
    utc.setUTCHours(0, 0, 0, 0);
    return utc;
  }
  return new Date(`${year}-${month}-${day}T00:00:00+05:00`);
}
