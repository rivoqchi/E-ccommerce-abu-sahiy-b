import { Injectable, Logger } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import {
  PaymentWebhookDto,
  PaymentWebhookEvent,
} from './dto/payment-webhook.dto';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order } from '../orders/schemas/order.schema';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly ordersService: OrdersService,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
  ) {}

  async handleWebhook(dto: PaymentWebhookDto) {
    this.logger.log(
      `Payment webhook ${dto.event} for order ${dto.orderId} (${dto.provider ?? 'generic'})`,
    );

    await this.orderModel
      .findByIdAndUpdate(dto.orderId, {
        $set: { paymentRef: dto.providerRef },
      })
      .exec();

    if (dto.event === PaymentWebhookEvent.Succeeded) {
      const order = await this.ordersService.updateStatus(
        dto.orderId,
        OrderStatus.Paid,
      );
      return { handled: true, order };
    }

    if (dto.event === PaymentWebhookEvent.Failed) {
      const order = await this.ordersService.updateStatus(
        dto.orderId,
        OrderStatus.Cancelled,
      );
      return { handled: true, order };
    }

    return { handled: true, event: dto.event };
  }
}
