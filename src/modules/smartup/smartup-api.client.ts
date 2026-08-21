import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type SmartupBalanceRow = {
  barcode: string;
  quantity: number;
  raw: Record<string, unknown>;
};

const BARCODE_KEYS = [
  'barcode',
  'bar_code',
  'product_barcode',
  'inventory_barcode',
  'shtrix_kod',
  'shtrih_kod',
  'gtin',
  'ean',
  'code',
  'product_code',
  'inventory_code',
  'product_id',
];

const QUANTITY_KEYS = [
  'quantity',
  'qty',
  'balance',
  'amount',
  'stock',
  'ostatok',
  'qoldiq',
  'inventory_quantity',
  'available_quantity',
  'quantity_balance',
  'quant',
  'count',
];

@Injectable()
export class SmartupApiClient {
  private readonly logger = new Logger(SmartupApiClient.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    const enabled = this.config.get<boolean>('smartup.enabled');
    const username = this.config.get<string>('smartup.username')?.trim();
    const password = this.config.get<string>('smartup.password');
    return Boolean(enabled && username && password !== undefined && password !== '');
  }

  private buildUrl(): string {
    const base = this.config.getOrThrow<string>('smartup.baseUrl').replace(/\/$/, '');
    let path = this.config.getOrThrow<string>('smartup.inventoryBalancePath');
    if (!path.startsWith('/')) path = `/${path}`;
    return `${base}${path}`;
  }

  /**
   * POST Inventory Balance / Export — ombor qoldiqlari.
   * Response maydonlari filialga qarab farq qilishi mumkin; flexible parse.
   */
  async exportInventoryBalances(
    body: Record<string, unknown> = {},
  ): Promise<SmartupBalanceRow[]> {
    const username = this.config.getOrThrow<string>('smartup.username');
    const password = this.config.getOrThrow<string>('smartup.password');
    const url = this.buildUrl();
    const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(
        `Smartup inventory balance failed: ${res.status} ${text.slice(0, 400)}`,
      );
      throw new Error(`Smartup API xato: HTTP ${res.status}`);
    }

    const data: unknown = await res.json();
    return this.parseBalances(data);
  }

  parseBalances(data: unknown): SmartupBalanceRow[] {
    const rows = this.extractArray(data);
    const out: SmartupBalanceRow[] = [];

    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const barcode = this.pickString(raw, BARCODE_KEYS);
      const quantity = this.pickNumber(raw, QUANTITY_KEYS);
      if (!barcode || quantity === null) continue;
      out.push({
        barcode: barcode.replace(/\s+/g, '').trim(),
        quantity: Math.max(0, Math.floor(quantity)),
        raw,
      });
    }

    return out;
  }

  private extractArray(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];

    const obj = data as Record<string, unknown>;
    const preferredKeys = [
      'inventory_balance',
      'inventory_balances',
      'balance',
      'balances',
      'data',
      'items',
      'rows',
      'inventory',
      'product',
      'products',
    ];

    for (const key of preferredKeys) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }

    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        return v;
      }
    }

    return [];
  }

  private pickString(
    raw: Record<string, unknown>,
    keys: string[],
  ): string | null {
    const lowerMap = new Map(
      Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const key of keys) {
      const v = lowerMap.get(key.toLowerCase());
      if (v == null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return null;
  }

  private pickNumber(
    raw: Record<string, unknown>,
    keys: string[],
  ): number | null {
    const lowerMap = new Map(
      Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const key of keys) {
      const v = lowerMap.get(key.toLowerCase());
      if (v == null || v === '') continue;
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }
    return null;
  }
}
