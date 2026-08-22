import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ProductStatus } from '../../../common/enums/product-status.enum';

export type HamkorProductDocument = HydratedDocument<HamkorProduct>;

@Schema({ _id: false })
export class HamkorProductSpec {
  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({ required: true, trim: true })
  value!: string;
}

export const HamkorProductSpecSchema =
  SchemaFactory.createForClass(HamkorProductSpec);

@Schema({ timestamps: true, collection: 'hamkor_products' })
export class HamkorProduct {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, trim: true, uppercase: true })
  code!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string;

  @Prop({ default: '' })
  description!: string;

  /** Oddiy (retail) narx — USD (legacy; vitrinada optom × kurs × 1.10) */
  @Prop({ required: true, min: 0 })
  price!: number;

  /** Optom (wholesale) narx — USD */
  @Prop({ min: 0, default: 0 })
  wholesalePrice!: number;

  @Prop({ min: 0 })
  compareAtPrice?: number;

  @Prop({ required: true, min: 0, default: 0 })
  stock!: number;

  @Prop({
    type: Types.ObjectId,
    ref: 'HamkorPartner',
    required: true,
    index: true,
  })
  partnerId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'HamkorCategory',
    required: true,
    index: true,
  })
  categoryId!: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  images!: string[];

  @Prop({ type: [HamkorProductSpecSchema], default: [] })
  specs!: HamkorProductSpec[];

  @Prop({ type: String, enum: ProductStatus, default: ProductStatus.Draft })
  status!: ProductStatus;

  @Prop({ default: true })
  isActive!: boolean;
}

export const HamkorProductSchema = SchemaFactory.createForClass(HamkorProduct);
HamkorProductSchema.index({ partnerId: 1, status: 1 });
HamkorProductSchema.index({ categoryId: 1, status: 1 });
HamkorProductSchema.index({ status: 1, isActive: 1, createdAt: -1 });
HamkorProductSchema.index({
  name: 'text',
  description: 'text',
  code: 'text',
});
