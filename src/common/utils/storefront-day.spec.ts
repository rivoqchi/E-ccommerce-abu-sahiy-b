import { startOfTodayInTashkent } from './storefront-day';

describe('startOfTodayInTashkent', () => {
  it('returns midnight Tashkent for a known instant', () => {
    const instant = new Date('2026-03-15T10:30:00.000Z');
    const start = startOfTodayInTashkent(instant);
    expect(start.toISOString()).toBe('2026-03-14T19:00:00.000Z');
  });

  it('uses Tashkent calendar day near UTC midnight', () => {
    const instant = new Date('2026-03-15T02:00:00.000Z');
    expect(startOfTodayInTashkent(instant).toISOString()).toBe(
      '2026-03-14T19:00:00.000Z',
    );

    const lateUtc = new Date('2026-03-14T20:00:00.000Z');
    expect(startOfTodayInTashkent(lateUtc).toISOString()).toBe(
      '2026-03-14T19:00:00.000Z',
    );
  });
});
