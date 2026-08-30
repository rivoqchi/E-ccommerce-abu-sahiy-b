import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { ProductSource } from '../../../common/enums/product-source.enum';
import { OrderItemFulfillment } from '../../../common/enums/order-item-fulfillment.enum';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: false })
export class OrderSubstituteItem {
  @Prop({ type: Types.ObjectId, required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  slug!: string;

  @Prop({ required: true, min: 1 })
  quantity!: number;

  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  @Prop({ type: String, enum: ProductSource, default: ProductSource.Store })
  source?: ProductSource;

  @Prop()
  partnerId?: string;

  @Prop()
  partnerName?: string;

  @Prop()
  image?: string;
}

export const OrderSubstituteItemSchema =
  SchemaFactory.createForClass(OrderSubstituteItem);

@Schema({ _id: false })
export class OrderItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  slug!: string;

  /** Mijoz buyurtma qilgan son. */
  @Prop({ required: true, min: 1 })
  quantity!: number;

  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  @Prop({ type: String, enum: ProductSource, default: ProductSource.Store })
  source?: ProductSource;

  @Prop()
  partnerId?: string;

  @Prop()
  partnerName?: string;

  /** Ombordan berilgan son. Yo‘q bo‘lsa — quantity. */
  @Prop({ min: 0 })
  givenQuantity?: number;

  @Prop({
    type: String,
    enum: OrderItemFulfillment,
    default: OrderItemFulfillment.Given,
  })
  fulfillmentStatus?: OrderItemFulfillment;

  @Prop({ type: [OrderSubstituteItemSchema], default: [] })
  substitutes?: OrderSubstituteItem[];

  @Prop()
  image?: string;
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class ShippingAddress {
  @Prop({ required: true })
  fullName!: string;

  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true })
  line1!: string;

  @Prop()
  line2?: string;

  @Prop({ required: true })
  city!: string;

  @Prop({ required: true })
  country!: string;

  @Prop()
  postalCode?: string;
}

export const ShippingAddressSchema =
  SchemaFactory.createForClass(ShippingAddress);

@Schema({ _id: false })
export class ExcelNotifyMessage {
  @Prop({ required: true })
  chatId!: string;

  @Prop({ required: true })
  messageId!: number;
}

export const ExcelNotifyMessageSchema =
  SchemaFactory.createForClass(ExcelNotifyMessage);

@Schema({ _id: false })
export class ExcelSeenBy {
  @Prop({ required: true })
  telegramId!: string;

  @Prop({ trim: true })
  username?: string;

  @Prop({ trim: true })
  fullName?: string;

  @Prop({ required: true })
  seenAt!: Date;
}

export const ExcelSeenBySchema = SchemaFactory.createForClass(ExcelSeenBy);

@Schema({ timestamps: true, collection: 'orders' })
export class Order {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: [OrderItemSchema], required: true })
  items!: OrderItem[];

  @Prop({ required: true, min: 0 })
  subtotal!: number;

  @Prop({ required: true, min: 0, default: 0 })
  shippingFee!: number;

  @Prop({ required: true, min: 0 })
  total!: number;

  /** Optom buyurtma USD, oddiy — UZS */
  @Prop({ type: String, default: 'UZS' })
  currency?: string;

  @Prop({ type: String, enum: OrderStatus, default: OrderStatus.Pending })
  status!: OrderStatus;

  @Prop({ type: ShippingAddressSchema, required: true })
  shippingAddress!: ShippingAddress;

  @Prop()
  paymentRef?: string;

  @Prop()
  notes?: string;

  /** Fulfillmentdan oldingi summa (mijoz ko‘rsin). */
  @Prop({ min: 0 })
  originalSubtotal?: number;

  @Prop({ min: 0 })
  originalShippingFee?: number;

  @Prop({ min: 0 })
  originalTotal?: number;

  @Prop()
  fulfilledAt?: Date;

  @Prop({ type: [ExcelNotifyMessageSchema], default: [] })
  excelNotifyMessages!: ExcelNotifyMessage[];

  @Prop({ type: [ExcelSeenBySchema], default: [] })
  excelSeenBy!: ExcelSeenBy[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
