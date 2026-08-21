import { ConfigService } from '@nestjs/config';
import { SmartupApiClient } from './smartup-api.client';

describe('SmartupApiClient.parseBalances', () => {
  const client = new SmartupApiClient({
    get: () => undefined,
    getOrThrow: (k: string) => k,
  } as unknown as ConfigService);

  it('parses balance array with product_code + quantity (ombor soni)', () => {
    const rows = client.parseBalances({
      balance: [
        {
          date: '16.02.2023',
          warehouse_code: '001wrh',
          product_code: '002pr',
          product_id: '21',
          quantity: '1400',
          inventory_kind: 'G',
        },
        {
          date: '16.02.2023',
          product_code: 'MGFR 821',
          quantity: 34,
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        productCode: '002PR',
        quantity: 1400,
      }),
    );
    expect(rows[1]).toEqual(
      expect.objectContaining({
        productCode: 'MGFR821',
        quantity: 34,
      }),
    );
  });

  it('aggregates quantity by product_code for latest date across warehouses', () => {
    const rows = client.parseBalances({
      balance: [
        {
          date: '15.02.2023',
          product_code: 'A1',
          warehouse_code: 'W1',
          quantity: '10',
        },
        {
          date: '16.02.2023',
          product_code: 'A1',
          warehouse_code: 'W1',
          quantity: '5',
        },
        {
          date: '16.02.2023',
          product_code: 'A1',
          warehouse_code: 'W2',
          quantity: '7',
        },
      ],
    });
    const map = client.aggregateQuantitiesByProductCode(rows);
    expect(map.get('A1')).toBe(12); // 5+7 on latest date
  });

  it('skips rows without product_code or quantity', () => {
    const rows = client.parseBalances({
      balance: [{ product_code: 'X' }, { quantity: 1 }],
    });
    expect(rows).toHaveLength(0);
  });
});
