import {
  NEW_HIGHLIGHT_DAYS,
  isNewHighlightActive,
  newHighlightUntilFromNow,
} from './product-new-highlight';

describe('product-new-highlight', () => {
  it('adds highlight days from now', () => {
    const now = new Date('2026-03-15T12:00:00.000Z');
    const until = newHighlightUntilFromNow(now);
    expect(until.getTime() - now.getTime()).toBe(
      NEW_HIGHLIGHT_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it('detects active highlight window', () => {
    const now = new Date('2026-03-15T12:00:00.000Z');
    const future = new Date('2026-03-20T12:00:00.000Z');
    const past = new Date('2026-03-10T12:00:00.000Z');
    expect(isNewHighlightActive(future, now)).toBe(true);
    expect(isNewHighlightActive(past, now)).toBe(false);
    expect(isNewHighlightActive(undefined, now)).toBe(false);
  });
});
