import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order } from './schemas/order.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { CartService } from '../cart/cart.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { RealtimeService } from '../realtime/realtime.service';

const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.Pending]: [OrderStatus.Paid, OrderStatus.Cancelled],
  [OrderStatus.Paid]: [OrderStatus.Shipped, OrderStatus.Cancelled],
  [OrderStatus.Shipped]: [OrderStatus.Delivered],
  [OrderStatus.Delivered]: [],
  [OrderStatus.Cancelled]: [],
};

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly cartService: CartService,
    private readonly inventoryService: InventoryService,
    private readonly realtime: RealtimeService,
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
    const shippingFee = subtotal >= 100 ? 0 : 5;
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
}
