import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InventoryService } from '../inventory/inventory.service';
import { ProductsService } from '../products/products.service';
import { SmartupApiClient } from './smartup-api.client';

export type SmartupSyncResult = {
  skipped: boolean;
  reason?: string;
  fetched: number;
  matched: number;
  updated: number;
  unchanged: number;
  errors: string[];
};

@Injectable()
export class SmartupStockSyncService {
  private readonly logger = new Logger(SmartupStockSyncService.name);
  private running = false;

  constructor(
    private readonly api: SmartupApiClient,
    private readonly productsService: ProductsService,
    private readonly inventoryService: InventoryService,
  ) {}

  /** Dynamic cron from SMARTUP_SYNC_CRON (default: every 10 minutes) */
  @Cron(process.env.SMARTUP_SYNC_CRON?.trim() || '*/10 * * * *')
  async handleCron() {
    if (!this.api.isConfigured()) return;
    await this.syncStock();
  }

  /**
   * Smartup Balance `quantity` → lokal `stock` (faqat soni).
   * Moslash: product_code ↔ code, yoki barcode ↔ inventory$export orqali code.
   */
  async syncStock(): Promise<SmartupSyncResult> {
    if (!this.api.isConfigured()) {
      return {
        skipped: true,
        reason: 'Smartup o‘chirilgan yoki credentials yo‘q',
        fetched: 0,
        matched: 0,
        updated: 0,
        unchanged: 0,
        errors: [],
      };
    }

    if (this.running) {
      return {
        skipped: true,
        reason: 'Sync allaqachon ishlayapti',
        fetched: 0,
        matched: 0,
        updated: 0,
        unchanged: 0,
        errors: [],
      };
    }

    this.running = true;
    const errors: string[] = [];
    let fetched = 0;
    let matched = 0;
    let updated = 0;
    let unchanged = 0;

    try {
      this.logger.log('Smartup Balance sync boshlandi (faqat stock)');
      const rows = await this.api.exportInventoryBalances();
      fetched = rows.length;

      const qtyByCode = this.api.aggregateQuantitiesByProductCode(rows);
      const barcodeToCode = await this.api.exportInventoryBarcodeMap();

      const products = await this.productsService.findForStockSync();

      for (const product of products) {
        const code = this.api.normCode(String(product.code ?? ''));
        const barcode = this.resolveProductBarcode(product);

        let qty: number | undefined;
        if (code && qtyByCode.has(code)) {
          qty = qtyByCode.get(code);
        } else if (barcode && barcodeToCode.has(barcode)) {
          const mappedCode = barcodeToCode.get(barcode)!;
          if (qtyByCode.has(mappedCode)) {
            qty = qtyByCode.get(mappedCode);
          }
        } else if (barcode) {
          // Balance qatorida to‘g‘ridan-to‘g‘ri barcode bo‘lsa
          for (const row of rows) {
            if (row.barcode === barcode) {
              qty = (qty ?? 0) + row.quantity;
            }
          }
        }

        if (qty === undefined) continue;

        matched += 1;
        const current = Number(product.stock) || 0;
        if (current === qty) {
          unchanged += 1;
          continue;
        }

        try {
          await this.inventoryService.overwriteStockOnly(
            String(product._id),
            qty,
          );
          updated += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${product.code ?? product._id}: ${msg}`);
          this.logger.warn(`Stock sync xato ${product.code}: ${msg}`);
        }
      }

      this.logger.log(
        `Smartup sync tugadi: fetched=${fetched} matched=${matched} updated=${updated} unchanged=${unchanged} errors=${errors.length}`,
      );

      return {
        skipped: false,
        fetched,
        matched,
        updated,
        unchanged,
        errors,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Smartup sync failed: ${msg}`);
      return {
        skipped: false,
        fetched,
        matched,
        updated,
        unchanged,
        errors: [msg, ...errors],
      };
    } finally {
      this.running = false;
    }
  }

  private resolveProductBarcode(product: {
    barcode?: string | null;
    specs?: Array<{ label?: string; value?: string }>;
  }): string | null {
    const direct = product.barcode?.replace(/\s+/g, '').trim();
    if (direct) return direct;

    for (const spec of product.specs ?? []) {
      const label = (spec.label ?? '').toLowerCase();
      if (
        label.includes('штрих') ||
        label.includes('barcode') ||
        label.includes('shtrix')
      ) {
        const v = (spec.value ?? '').replace(/\s+/g, '').trim();
        if (v) return v;
      }
    }
    return null;
  }
}
