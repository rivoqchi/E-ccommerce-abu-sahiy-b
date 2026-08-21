import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProductsService } from '../products/products.service';
import { RealtimeService } from '../realtime/realtime.service';

@Injectable()
export class InventoryService {
  constructor(
    private readonly productsService: ProductsService,
    private readonly realtime: RealtimeService,
    private readonly configService: ConfigService,
  ) {}

  async reserve(productId: string, quantity: number) {
    const product = await this.productsService.adjustStock(productId, -quantity);
    this.emitStock(product);
    return product;
  }

  async release(productId: string, quantity: number) {
    const product = await this.productsService.adjustStock(productId, quantity);
    this.emitStock(product);
    return product;
  }

  async setStock(productId: string, stock: number) {
    const current = await this.productsService.findById(productId);
    const delta = stock - current.stock;
    const product = await this.productsService.adjustStock(productId, delta);
    this.emitStock(product);
    return product;
  }

  /**
   * Smartup/ERP sync: faqat `stock` maydonini yozadi.
   * name, price, images, specs va boshqa maydonlarga tegilmaydi.
   */
  async overwriteStockOnly(productId: string, stock: number) {
    const product = await this.productsService.setStockOnly(productId, stock);
    this.emitStock(product);
    return product;
  }

  private emitStock(product: {
    _id: { toString(): string };
    stock: number;
    slug: string;
    name: string;
  }) {
    const productId = product._id.toString();
    const payload = {
      productId,
      stock: product.stock,
      slug: product.slug,
    };

    this.realtime.emitProductStock(productId, payload);

    const threshold = this.configService.get<number>('lowStockThreshold', 5);
    if (product.stock <= threshold) {
      this.realtime.emitAdminAlert({
        type: 'low_stock',
        productId,
        name: product.name,
        stock: product.stock,
      });
    }
  }
}
