import { ConfigService } from '@nestjs/config';
import { SmartupApiClient } from './smartup-api.client';

describe('SmartupApiClient.parseBalances', () => {
  const client = new SmartupApiClient({
    get: () => undefined,
    getOrThrow: (k: string) => k,
  } as unknown as ConfigService);

  it('parses inventory_balance array with barcode + quantity', () => {
    const rows = client.parseBalances({
      inventory_balance: [
        { barcode: '4601234567890', quantity: 12 },
        { product_barcode: '111', balance: '3.5' },
      ],
    });
    expect(rows).toEqual([
      expect.objectContaining({ barcode: '4601234567890', quantity: 12 }),
      expect.objectContaining({ barcode: '111', quantity: 3 }),
    ]);
  });

  it('skips rows without barcode or quantity', () => {
    const rows = client.parseBalances({
      data: [{ code: 'X' }, { barcode: '9', stock: 1 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.barcode).toBe('9');
    expect(rows[0]!.quantity).toBe(1);
  });
});
