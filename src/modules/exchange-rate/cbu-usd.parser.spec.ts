import { parseCbuUsdPayload } from './cbu-usd.parser';

describe('parseCbuUsdPayload', () => {
  it('reads Rate and Date from CBU JSON array', () => {
    expect(
      parseCbuUsdPayload([
        {
          Ccy: 'USD',
          Rate: '12854.89',
          Date: '22.08.2026',
        },
      ]),
    ).toEqual({
      usdToUzs: 12854.89,
      date: '22.08.2026',
      source: 'cbu',
    });
  });

  it('accepts comma decimals', () => {
    expect(parseCbuUsdPayload({ Rate: '12850,50', Date: '22.08.2026' }).usdToUzs).toBe(
      12850.5,
    );
  });

  it('rejects missing rate', () => {
    expect(() => parseCbuUsdPayload([])).toThrow();
    expect(() => parseCbuUsdPayload({ Rate: '0' })).toThrow();
  });
});
