import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order } from './schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { StorefrontCheckoutDto } from './dto/storefront-checkout.dto';
import { CartService } from '../cart/cart.service';
import { InventoryService } from '../inventory/inventory.service';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { HamkorProductsService } from '../hamkor-products/hamkor-products.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { ProductSource } from '../../common/enums/product-source.enum';
import { RealtimeService } from '../realtime/realtime.service';
import { PriceTier } from '../../common/enums/price-tier.enum';
import { resolveUnitPrice, shippingFeeForTier, orderCurrency } from '../../common/utils/pricing';
import { isStorefrontReadyProduct } from '../products/product-completeness';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

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

    this.realtime.emitAdminAlert({
      type: 'new_order',
      orderId: order._id.toString(),
      total: order.total,
    });

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
      if (product.stock < line.quantity) {
        throw new BadRequestException(
          `Yetarli ombor yo'q: ${product.name} (qoldiq ${product.stock})`,
        );
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

    this.realtime.emitAdminAlert({
      type: 'new_order',
      orderId: order._id.toString(),
      total: order.total,
    });

    return {
      ...order.toObject(),
      message: 'Buyurtma qilindi',
    };
  }
  async findMine(userId: string) {
    return this.orderModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async findById(id: string, userId?: string, isAdmin = false) {
    const order = await this.orderModel.findById(id).lean().exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (!isAdmin && order.userId.toString() !== userId) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  async findAllAdmin() {
    return this.orderModel.find().sort({ createdAt: -1 }).lean().exec();
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
      for (const item of order.items) {
        await this.inventoryService.release(
          item.productId.toString(),
          item.quantity,
        );
      }
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
