import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type XitoyProductDocument = HydratedDocument<XitoyProduct>;

@Schema({ timestamps: true, collection: 'xitoy_products' })
export class XitoyProduct {
  @Prop({ required: true, trim: true })
  imageUrl!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, min: 0 })
  chinaPriceYuan!: number;

  @Prop({ required: true, min: 0 })
  cubicM3!: number;

  @Prop({ required: true, min: 0 })
  weightKg!: number;

  /** Tan narxi ($) — avtomatik hisoblanadi */
  @Prop({ required: true, min: 0 })
  wholesalePrice!: number;

  /** Tan narxi (¥) — avtomatik hisoblanadi */
  @Prop({ required: true, min: 0 })
  costPriceYuan!: number;

  @Prop({ required: true, min: 0 })
  yuanRate!: number;

  /** 'yuan' = 1$ = X¥, 'usd' = 1¥ = X$ */
  @Prop({ required: true, enum: ['yuan', 'usd'], default: 'yuan' })
  yuanRateUnit!: 'yuan' | 'usd';

  @Prop({ required: true, min: 0 })
  customsFee!: number;
}

export const XitoyProductSchema = SchemaFactory.createForClass(XitoyProduct);
XitoyProductSchema.index({ createdAt: -1 });
