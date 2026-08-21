import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type SmartupBalanceRow = {
  /** Smartup product_code (SKU) */
  productCode: string;
  /** Agar API bersa */
  barcode?: string;
  quantity: number;
  date?: string;
  warehouseCode?: string;
  raw: Record<string, unknown>;
};

@Injectable()
export class SmartupApiClient {
  private readonly logger = new Logger(SmartupApiClient.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    const enabled = this.config.get<boolean>('smartup.enabled');
    const username = this.config.get<string>('smartup.username')?.trim();
    const password = this.config.get<string>('smartup.password');
    return Boolean(
      enabled && username && password !== undefined && password !== '',
    );
  }

  private buildUrl(pathKey: 'inventoryBalancePath' | 'inventoryPath'): string {
    const base = this.config
      .getOrThrow<string>('smartup.baseUrl')
      .replace(/\/$/, '');
    let path =
      pathKey === 'inventoryPath'
        ? this.config.get<string>('smartup.inventoryPath') ||
          '/b/anor/mxsx/mr/inventory$export'
        : this.config.getOrThrow<string>('smartup.inventoryBalancePath');
    if (!path.startsWith('/')) path = `/${path}`;
    return `${base}${path}`;
  }

  private authHeader(): string {
    const username = this.config.getOrThrow<string>('smartup.username');
    const password = this.config.getOrThrow<string>('smartup.password');
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  }

  /** dd.mm.yyyy */
  private formatDate(d: Date): string {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }

  /** Inventory Balance / Export — ombor qoldig‘i (quantity) */
  buildBalanceRequestBody(): Record<string, unknown> {
    const end = new Date();
    const begin = new Date();
    const days = this.config.get<number>('smartup.balanceDays') ?? 30;
    begin.setDate(end.getDate() - Math.max(1, days));

    const filialCode =
      this.config.get<string>('smartup.filialCode')?.trim() || '';
    const warehouseCode =
      this.config.get<string>('smartup.warehouseCode')?.trim() || '';

    return {
      warehouse_codes: [{ warehouse_code: warehouseCode }],
      filial_code: filialCode,
      product_conditions: ['T', 'B', 'F'],
      begin_date: this.formatDate(begin),
      end_date: this.formatDate(end),
    };
  }

  async exportInventoryBalances(
    body?: Record<string, unknown>,
  ): Promise<SmartupBalanceRow[]> {
    const url = this.buildUrl('inventoryBalancePath');
    const payload = body ?? this.buildBalanceRequestBody();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: this.authHeader(),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(
        `Smartup inventory balance failed: ${res.status} ${text.slice(0, 400)}`,
      );
      throw new Error(`Smartup Balance API xato: HTTP ${res.status}`);
    }

    const data: unknown = await res.json();
    return this.parseBalances(data);
  }

  /**
   * Inventory / Export — barcode ↔ product code xarita (balance da barcode yo‘q).
   */
  async exportInventoryBarcodeMap(): Promise<Map<string, string>> {
    const url = this.buildUrl('inventoryPath');
    const map = new Map<string, string>();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: this.authHeader(),
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        this.logger.warn(`inventory$export barcode map: HTTP ${res.status}`);
        return map;
      }
      const data = (await res.json()) as { inventory?: unknown[] };
      const rows = Array.isArray(data.inventory) ? data.inventory : [];
      for (const item of rows) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const code = this.normCode(String(row.code ?? ''));
        const barcodes = String(row.barcodes ?? row.barcode ?? '')
          .split(/[,;|]/)
          .map((b) => b.replace(/\s+/g, '').trim())
          .filter(Boolean);
        if (!code) continue;
        for (const bc of barcodes) {
          map.set(bc, code);
        }
      }
    } catch (e) {
      this.logger.warn(
        `inventory$export barcode map xato: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return map;
  }

  parseBalances(data: unknown): SmartupBalanceRow[] {
    const rows = this.extractBalanceArray(data);
    const out: SmartupBalanceRow[] = [];

    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const productCode = this.normCode(
        String(raw.product_code ?? raw.code ?? ''),
      );
      const quantity = this.parseQty(raw.quantity);
      if (!productCode || quantity === null) continue;

      const barcodeRaw = raw.barcodes ?? raw.barcode;
      const barcode = barcodeRaw
        ? String(barcodeRaw).replace(/\s+/g, '').trim()
        : undefined;

      out.push({
        productCode,
        ...(barcode ? { barcode } : {}),
        quantity,
        date: raw.date != null ? String(raw.date) : undefined,
        warehouseCode:
          raw.warehouse_code != null ? String(raw.warehouse_code) : undefined,
        raw,
      });
    }

    return out;
  }

  /**
   * Bir product_code uchun omborlar bo‘yicha yig‘indi.
   * Bir xil sana oralig‘ida bir necha qator bo‘lsa — eng oxirgi sana, shu kunda omborlar yig‘indisi.
   */
  aggregateQuantitiesByProductCode(
    rows: SmartupBalanceRow[],
  ): Map<string, number> {
    // productCode -> date -> sum
    const byCodeDate = new Map<string, Map<string, number>>();

    for (const row of rows) {
      const dateKey = row.date || '_';
      let dates = byCodeDate.get(row.productCode);
      if (!dates) {
        dates = new Map();
        byCodeDate.set(row.productCode, dates);
      }
      dates.set(dateKey, (dates.get(dateKey) || 0) + row.quantity);
    }

    const result = new Map<string, number>();
    for (const [code, dates] of byCodeDate) {
      if (dates.size === 1 && dates.has('_')) {
        result.set(code, dates.get('_')!);
        continue;
      }
      // Eng kech sana (dd.mm.yyyy)
      let bestDate = '';
      let bestQty = 0;
      for (const [d, qty] of dates) {
        if (d === '_') continue;
        if (!bestDate || this.dateKeyValue(d) >= this.dateKeyValue(bestDate)) {
          bestDate = d;
          bestQty = qty;
        }
      }
      if (bestDate) result.set(code, bestQty);
      else if (dates.has('_')) result.set(code, dates.get('_')!);
    }

    return result;
  }

  normCode(code: string): string {
    return code.replace(/\s+/g, '').trim().toUpperCase();
  }

  private dateKeyValue(d: string): number {
    // dd.mm.yyyy → yyyymmdd number
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d.trim());
    if (!m) return 0;
    return Number(`${m[3]}${m[2]}${m[1]}`);
  }

  private parseQty(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.floor(n));
  }

  private extractBalanceArray(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.balance)) return obj.balance;
    if (Array.isArray(obj.inventory_balance)) return obj.inventory_balance;
    if (Array.isArray(obj.balances)) return obj.balances;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    }
    return [];
  }
}
