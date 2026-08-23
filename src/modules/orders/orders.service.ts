import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderSubstituteItem } from './schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { StorefrontCheckoutDto } from './dto/storefront-checkout.dto';
import { UpdateOrderFulfillmentDto } from './dto/update-order-fulfillment.dto';
import { CartService } from '../cart/cart.service';
import { InventoryService } from '../inventory/inventory.service';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { HamkorProductsService } from '../hamkor-products/hamkor-products.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { ProductSource } from '../../common/enums/product-source.enum';
import { OrderItemFulfillment } from '../../common/enums/order-item-fulfillment.enum';
import { RealtimeService } from '../realtime/realtime.service';
import { PriceTier } from '../../common/enums/price-tier.enum';
import { resolveUnitPrice, shippingFeeForTier, orderCurrency } from '../../common/utils/pricing';
import { isStorefrontReadyProduct, firstProductImage } from '../products/product-completeness';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import {
  buildOrderWorkbook,
  buildOrdersListWorkbook,
  fetchExcelImage,
  type ExcelOrder,
} from './order-excel';

const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.Pending]: [OrderStatus.Paid, OrderStatus.Cancelled],
  [OrderStatus.Paid]: [OrderStatus.Shipped, OrderStatus.Cancelled],
  [OrderStatus.Shipped]: [OrderStatus.Delivered],
  [OrderStatus.Delivered]: [],
  [OrderStatus.Cancelled]: [],
};

function normalizePhone(phone: string): string {
  const trimmed = phone.trim().replace(/[\s-]/g, '');
  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('998')) return `+${trimmed}`;
  if (trimmed.startsWith('0')) return `+998${trimmed.slice(1)}`;
  return `+998${trimmed}`;
}

type HeldLine = {
  source?: ProductSource | string;
  productId?: Types.ObjectId | string;
  quantity: number;
  givenQuantity?: number;
  fulfillmentStatus?: string;
  substitutes?: Array<{
    source?: ProductSource | string;
    productId?: Types.ObjectId | string;
    quantity: number;
    unitPrice?: number;
  }>;
  unitPrice?: number;
};

function stockKey(source: string | undefined, productId: unknown): string {
  const src =
    source === ProductSource.Hamkor ? ProductSource.Hamkor : ProductSource.Store;
  return `${src}:${String(productId)}`;
}

function parseStockKey(key: string): { source: ProductSource; productId: string } {
  const sep = key.indexOf(':');
  const raw = sep === -1 ? ProductSource.Store : key.slice(0, sep);
  const source =
    raw === ProductSource.Hamkor ? ProductSource.Hamkor : ProductSource.Store;
  const productId = sep === -1 ? key : key.slice(sep + 1);
  return { source, productId };
}

function givenQuantityOf(item: HeldLine): number {
  if (item.fulfillmentStatus === OrderItemFulfillment.Unavailable) return 0;
  if (
    typeof item.givenQuantity === 'number' &&
    Number.isFinite(item.givenQuantity)
  ) {
    return Math.max(0, item.givenQuantity);
  }
  return item.quantity;
}

function collectHeldStock(items: HeldLine[]): Map<string, number> {
  const map = new Map<string, number>();
  const add = (
    source: string | undefined,
    productId: unknown,
    qty: number,
  ) => {
    if (!qty || !productId) return;
    const key = stockKey(source, productId);
    map.set(key, (map.get(key) ?? 0) + qty);
  };
  for (const item of items) {
    add(item.source, item.productId, givenQuantityOf(item));
    for (const sub of item.substitutes ?? []) {
      add(sub.source, sub.productId, sub.quantity);
    }
  }
  return map;
}

function billedSubtotalOf(items: HeldLine[]): number {
  let sum = 0;
  for (const item of items) {
    sum += givenQuantityOf(item) * (item.unitPrice ?? 0);
    for (const sub of item.substitutes ?? []) {
      sum += sub.quantity * (sub.unitPrice ?? 0);
    }
  }
  return sum;
}

function partnerFields(product: {
  partnerId?: Types.ObjectId | { _id?: Types.ObjectId; name?: string };
}) {
  const partnerRef = product.partnerId;
  const partnerId =
    partnerRef && typeof partnerRef === 'object' && '_id' in partnerRef
      ? String(partnerRef._id)
      : partnerRef
        ? String(partnerRef)
        : undefined;
  const partnerName =
    partnerRef && typeof partnerRef === 'object' && 'name' in partnerRef
      ? partnerRef.name
      : undefined;
  return { partnerId, partnerName };
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly cartService: CartService,
    private readonly inventoryService: InventoryService,
    private readonly usersService: UsersService,
    private readonly productsService: ProductsService,
    private readonly hamkorProductsService: HamkorProductsService,
    private readonly realtime: RealtimeService,
    private readonly exchangeRate: ExchangeRateService,
  ) {}

  async create(userId: string, dto: CreateOrderDto) {
    const cart = await this.cartService.getCartDocument(userId, dto.guestId);
    if (!cart.items.length) {
      throw new BadRequestException('Cart is empty');
    }

    for (const item of cart.items) {
      await this.inventoryService.reserve(
        item.productId.toString(),
        item.quantity,
      );
    }

    const subtotal = cart.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );
    const user = await this.usersService.findById(userId);
    const priceTier = user.priceTier ?? PriceTier.Retail;
    const rate = await this.exchangeRate.getRate();
    const shippingFee = shippingFeeForTier(subtotal, rate, priceTier);
    const total = subtotal + shippingFee;

    const order = await this.orderModel.create({
      userId: new Types.ObjectId(userId),
      items: cart.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        slug: item.slug ?? '',
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        image: item.image,
      })),
      subtotal,
      shippingFee,
      total,
      currency: orderCurrency(priceTier),
      status: OrderStatus.Pending,
      shippingAddress: dto.shippingAddress,
      notes: dto.notes,
    });

    await this.cartService.clear(userId, dto.guestId);

    this.emitNewOrderAlert(order);

    return order.toObject();
  }

  /** Storefront checkout — local cart items + contact form. */
  async storefrontCheckout(dto: StorefrontCheckoutDto) {
    const phone = normalizePhone(dto.phone);
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const fullName = `${firstName} ${lastName}`.trim();

    const user = await this.usersService.findOrCreateByPhone(phone, {
      fullName,
      firstName,
      lastName,
    });

    const priceTier = user.priceTier ?? PriceTier.Retail;
    const rate = await this.exchangeRate.getRate();

    const lines: Array<{
      productId: Types.ObjectId;
      name: string;
      slug: string;
      quantity: number;
      unitPrice: number;
      source: ProductSource;
      partnerId?: string;
      partnerName?: string;
      image?: string;
    }> = [];

    for (const line of dto.items) {
      const source =
        line.source === ProductSource.Hamkor
          ? ProductSource.Hamkor
          : ProductSource.Store;
      let product;
      try {
        product =
          source === ProductSource.Hamkor
            ? await this.hamkorProductsService.findById(line.productId)
            : await this.productsService.findById(line.productId);
      } catch (err) {
        if (err instanceof NotFoundException) {
          throw new BadRequestException(
            "Savatdagi ba'zi mahsulotlar topilmadi. Savatni yangilang va qayta urinib ko'ring.",
          );
        }
        throw err;
      }
      if (!isStorefrontReadyProduct(product)) {
        throw new BadRequestException(`Mahsulot mavjud emas: ${product.name}`);
      }
      const partnerRef = (
        product as {
          partnerId?:
            | Types.ObjectId
            | { _id?: Types.ObjectId; name?: string };
        }
      ).partnerId;
      const partnerId =
        partnerRef && typeof partnerRef === 'object' && '_id' in partnerRef
          ? String(partnerRef._id)
          : partnerRef
            ? String(partnerRef)
            : undefined;
      const partnerName =
        partnerRef && typeof partnerRef === 'object' && 'name' in partnerRef
          ? partnerRef.name
          : undefined;

      lines.push({
        productId: product._id as Types.ObjectId,
        name: product.name,
        slug: product.slug,
        quantity: line.quantity,
        unitPrice: resolveUnitPrice(product, priceTier, rate),
        source,
        partnerId,
        partnerName,
        image: firstProductImage(product.images),
      });
    }

    for (const line of lines) {
      if (line.source === ProductSource.Hamkor) {
        await this.hamkorProductsService.adjustStock(
          line.productId.toString(),
          -line.quantity,
        );
      } else {
        await this.inventoryService.reserve(
          line.productId.toString(),
          line.quantity,
        );
      }
    }

    const subtotal = lines.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );
    const shippingFee = shippingFeeForTier(subtotal, rate, priceTier);
    const total = subtotal + shippingFee;

    const order = await this.orderModel.create({
      userId: user._id,
      items: lines,
      subtotal,
      shippingFee,
      total,
      currency: orderCurrency(priceTier),
      status: OrderStatus.Pending,
      shippingAddress: {
        fullName,
        phone,
        line1: 'Yetkazib berish',
        city: 'Toshkent',
        country: "O'zbekiston",
      },
      notes: dto.notes?.trim() || undefined,
    });

    this.emitNewOrderAlert(order);

    return {
      ...order.toObject(),
      message: 'Buyurtma qilindi',
    };
  }
  async findMine(userId: string) {
    const rows = await this.orderModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return this.attachImages(rows);
  }

  async findById(id: string, userId?: string, isAdmin = false) {
    const order = await this.orderModel.findById(id).lean().exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (!isAdmin && order.userId.toString() !== userId) {
      throw new NotFoundException('Order not found');
    }

    const [enriched] = await this.attachImages([order]);
    return enriched;
  }

  async findAllAdmin() {
    const rows = await this.orderModel.find().sort({ createdAt: -1 }).lean().exec();
    return this.attachImages(rows);
  }

  async updateStatus(id: string, status: OrderStatus) {
    const order = await this.orderModel.findById(id).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const allowed = STATUS_FLOW[order.status] ?? [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Cannot transition from ${order.status} to ${status}`,
      );
    }

    if (status === OrderStatus.Cancelled && order.status !== OrderStatus.Cancelled) {
      const held = collectHeldStock(order.items as unknown as HeldLine[]);
      await this.applyHeldStockDiff(held, new Map());
    }

    order.status = status;
    await order.save();

    const payload = {
      orderId: order._id.toString(),
      status: order.status,
      updatedAt: new Date().toISOString(),
    };

    this.realtime.emitOrderStatus(order._id.toString(), payload);
    return order.toObject();
  }

  async updateFulfillment(id: string, dto: UpdateOrderFulfillmentDto) {
    const order = await this.orderModel.findById(id).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (
      order.status === OrderStatus.Cancelled ||
      order.status === OrderStatus.Delivered
    ) {
      throw new BadRequestException(
        'Yetkazilgan yoki bekor qilingan buyurtmani o‘zgartirib bo‘lmaydi',
      );
    }
    if (dto.items.length !== order.items.length) {
      throw new BadRequestException('Mahsulotlar soni mos emas');
    }

    const user = await this.usersService.findById(order.userId.toString());
    const priceTier = user.priceTier ?? PriceTier.Retail;
    const rate = await this.exchangeRate.getRate();
    const oldHeld = collectHeldStock(order.items as unknown as HeldLine[]);

    for (let i = 0; i < order.items.length; i++) {
      const current = order.items[i];
      const patch = dto.items[i];
      let given = Math.trunc(Number(patch.givenQuantity));
      if (!Number.isFinite(given) || given < 0) given = 0;

      const substitutes: OrderSubstituteItem[] = [];
      for (const sub of patch.substitutes ?? []) {
        substitutes.push(
          await this.buildSubstituteLine(sub.productId, sub.quantity, sub.source, priceTier, rate),
        );
      }

      const unavailable =
        Boolean(patch.unavailable) ||
        (given === 0 && substitutes.length === 0);
      if (unavailable) given = 0;

      const fulfillmentStatus =
        unavailable && substitutes.length === 0
          ? OrderItemFulfillment.Unavailable
          : substitutes.length > 0
            ? OrderItemFulfillment.Substituted
            : OrderItemFulfillment.Given;

      current.givenQuantity =
        fulfillmentStatus === OrderItemFulfillment.Unavailable ? 0 : given;
      current.fulfillmentStatus = fulfillmentStatus;
      current.substitutes = substitutes;
    }

    order.markModified('items');

    const newHeld = collectHeldStock(order.items as unknown as HeldLine[]);
    await this.applyHeldStockDiff(oldHeld, newHeld);

    const billedSubtotal = billedSubtotalOf(
      order.items as unknown as HeldLine[],
    );
    const shippingFee = shippingFeeForTier(billedSubtotal, rate, priceTier);

    if (order.originalTotal == null) {
      order.originalSubtotal = order.subtotal;
      order.originalShippingFee = order.shippingFee;
      order.originalTotal = order.total;
    }

    order.subtotal = billedSubtotal;
    order.shippingFee = shippingFee;
    order.total = billedSubtotal + shippingFee;
    order.fulfilledAt = new Date();
    await order.save();

    return order.toObject();
  }

  private async buildSubstituteLine(
    productId: string,
    quantity: number,
    sourceRaw: ProductSource | undefined,
    priceTier: PriceTier,
    rate: number,
  ): Promise<OrderSubstituteItem> {
    const source =
      sourceRaw === ProductSource.Hamkor
        ? ProductSource.Hamkor
        : ProductSource.Store;
    let product;
    try {
      product =
        source === ProductSource.Hamkor
          ? await this.hamkorProductsService.findById(productId)
          : await this.productsService.findById(productId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new BadRequestException('Almashtirish mahsuloti topilmadi');
      }
      throw err;
    }
    if (!isStorefrontReadyProduct(product)) {
      throw new BadRequestException(
        `Almashtirish uchun mahsulot mavjud emas: ${product.name}`,
      );
    }
    const { partnerId, partnerName } = partnerFields(
      product as {
        partnerId?: Types.ObjectId | { _id?: Types.ObjectId; name?: string };
      },
    );
    return {
      productId: product._id as Types.ObjectId,
      name: product.name,
      slug: product.slug,
      quantity,
      unitPrice: resolveUnitPrice(product, priceTier, rate),
      source,
      partnerId,
      partnerName,
      image: firstProductImage(product.images),
    };
  }

  private async applyStockDelta(
    productId: string,
    delta: number,
    source: ProductSource,
  ) {
    if (!delta || !productId) return;
    if (source === ProductSource.Hamkor) {
      await this.hamkorProductsService.adjustStock(productId, delta);
      return;
    }
    if (delta > 0) {
      await this.inventoryService.release(productId, delta);
    } else {
      await this.inventoryService.reserve(productId, -delta);
    }
  }

  private async applyHeldStockDiff(
    oldHeld: Map<string, number>,
    newHeld: Map<string, number>,
  ) {
    // delta > 0: omborga qaytarish; delta < 0: ombordan olish
    const keys = new Set([...oldHeld.keys(), ...newHeld.keys()]);
    const deltas: Array<{ key: string; delta: number }> = [];
    for (const key of keys) {
      const delta = (oldHeld.get(key) ?? 0) - (newHeld.get(key) ?? 0);
      if (delta) deltas.push({ key, delta });
    }
    deltas.sort((a, b) => b.delta - a.delta);
    for (const { key, delta } of deltas) {
      const { source, productId } = parseStockKey(key);
      await this.applyStockDelta(productId, delta, source);
    }
  }

  async excelForOrder(id: string) {
    const order = await this.findById(id, undefined, true);
    const urls = this.collectImageUrls(order.items);
    const images = await this.fetchExcelImages(urls);
    const wb = await buildOrderWorkbook(order as unknown as ExcelOrder, images);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `buyurtma-${String(order._id).slice(-8)}.xlsx`,
    };
  }

  async excelForAll() {
    const orders = await this.findAllAdmin();
    const wb = await buildOrdersListWorkbook(orders as unknown as ExcelOrder[]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { buffer, filename: `buyurtmalar_${stamp}.xlsx` };
  }

  private emitNewOrderAlert(order: {
    _id: Types.ObjectId;
    total: number;
    currency?: string;
    items?: unknown[];
    shippingAddress?: { fullName?: string };
  }) {
    this.realtime.emitAdminAlert({
      type: 'new_order',
      orderId: order._id.toString(),
      total: order.total,
      currency: order.currency,
      customerName: order.shippingAddress?.fullName ?? '',
      itemCount: order.items?.length ?? 0,
    });
  }

  private collectImageUrls(
    items?: Array<{
      image?: string;
      substitutes?: Array<{ image?: string }>;
    }>,
  ): string[] {
    const urls: string[] = [];
    for (const item of items ?? []) {
      if (item.image) urls.push(item.image);
      for (const sub of item.substitutes ?? []) {
        if (sub.image) urls.push(sub.image);
      }
    }
    return [...new Set(urls)];
  }

  private async fetchExcelImages(urls: string[]) {
    const map = new Map<
      string,
      { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' }
    >();
    const chunk = 4;
    for (let i = 0; i < urls.length; i += chunk) {
      const slice = urls.slice(i, i + chunk);
      const results = await Promise.all(slice.map((u) => fetchExcelImage(u)));
      slice.forEach((url, idx) => {
        const img = results[idx];
        if (img) map.set(url, img);
      });
    }
    return map;
  }

  private async attachImages<
    T extends {
      items?: Array<{
        productId?: unknown;
        source?: string;
        image?: string;
        substitutes?: Array<{
          productId?: unknown;
          source?: string;
          image?: string;
        }>;
      }>;
    },
  >(orders: T[]): Promise<T[]> {
    const storeIds: string[] = [];
    const hamkorIds: string[] = [];
    const consider = (
      source: string | undefined,
      productId: unknown,
      image?: string,
    ) => {
      if (image) return;
      const id = String(productId ?? '');
      if (!id || id === 'undefined') return;
      if (source === ProductSource.Hamkor) hamkorIds.push(id);
      else storeIds.push(id);
    };
    for (const order of orders) {
      for (const item of order.items ?? []) {
        consider(item.source, item.productId, item.image);
        for (const sub of item.substitutes ?? []) {
          consider(sub.source, sub.productId, sub.image);
        }
      }
    }
    const [storeMap, hamkorMap] = await Promise.all([
      this.productsService.mapFirstImages(storeIds),
      this.hamkorProductsService.mapFirstImages(hamkorIds),
    ]);
    const pick = (source: string | undefined, productId: unknown) => {
      const id = String(productId ?? '');
      return source === ProductSource.Hamkor
        ? hamkorMap.get(id)
        : storeMap.get(id);
    };
    for (const order of orders) {
      for (const item of order.items ?? []) {
        if (!item.image) item.image = pick(item.source, item.productId);
        for (const sub of item.substitutes ?? []) {
          if (!sub.image) sub.image = pick(sub.source, sub.productId);
        }
      }
    }
    return orders;
  }

  /** Unique paid buyers + recent avatars for product social proof. */
  async getProductBuyerStats(productId: string) {
    if (!Types.ObjectId.isValid(productId)) {
      return { buyerCount: 0, recentBuyers: [] as Array<{
        fullName: string;
        avatarUrl?: string;
      }> };
    }

    const paidStatuses = [
      OrderStatus.Paid,
      OrderStatus.Shipped,
      OrderStatus.Delivered,
    ];
    const productObjectId = new Types.ObjectId(productId);

    const [countRow, recentBuyers] = await Promise.all([
      this.orderModel
        .aggregate<{ buyerCount: number }>([
          {
            $match: {
              status: { $in: paidStatuses },
              'items.productId': productObjectId,
            },
          },
          { $group: { _id: '$userId' } },
          { $count: 'buyerCount' },
        ])
        .exec(),
      this.orderModel
        .aggregate<{
          fullName: string;
          avatarUrl?: string;
        }>([
          {
            $match: {
              status: { $in: paidStatuses },
              'items.productId': productObjectId,
            },
          },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$userId',
              lastAt: { $first: '$createdAt' },
            },
          },
          { $sort: { lastAt: -1 } },
          { $limit: 3 },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'user',
            },
          },
          { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              fullName: {
                $ifNull: ['$user.fullName', 'Xaridor'],
              },
              avatarUrl: '$user.avatarUrl',
            },
          },
        ])
        .exec(),
    ]);

    return {
      buyerCount: countRow[0]?.buyerCount ?? 0,
      recentBuyers,
    };
  }
}
