import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ProductStatus } from '../../../common/enums/product-status.enum';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ _id: false })
export class ProductSpec {
  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({ required: true, trim: true })
  value!: string;
}

export const ProductSpecSchema = SchemaFactory.createForClass(ProductSpec);

@Schema({ timestamps: true, collection: 'products' })
export class Product {
  @Prop({ required: true, trim: true })
  name!: string;

  /** Ichki mahsulot kodi (SKU) — unique */
  @Prop({ required: true, unique: true, trim: true, uppercase: true })
  code!: string;

  /** Shtrix-kod (Smartup ombor sync uchun) */
  @Prop({ trim: true, index: true, sparse: true })
  barcode?: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string;

  @Prop({ default: '' })
  description!: string;

  /** Oddiy (retail) narx — USD */
  @Prop({ required: true, min: 0 })
  price!: number;

  /** Optom (wholesale) narx — USD */
  @Prop({ min: 0, default: 0 })
  wholesalePrice!: number;

  @Prop({ min: 0 })
  compareAtPrice?: number;

  @Prop({ required: true, min: 0, default: 0 })
  stock!: number;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true, index: true })
  categoryId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Brand', index: true })
  brandId?: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  images!: string[];

  @Prop({ type: [ProductSpecSchema], default: [] })
  specs!: ProductSpec[];

  @Prop({ type: String, enum: ProductStatus, default: ProductStatus.Draft })
  status!: ProductStatus;

  @Prop()
  metaTitle?: string;

  @Prop()
  metaDescription?: string;

  @Prop()
  ogImage?: string;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ default: true })
  isActive!: boolean;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ categoryId: 1, status: 1 });
ProductSchema.index({ brandId: 1, status: 1 });
ProductSchema.index({ status: 1, isActive: 1, createdAt: -1 });
ProductSchema.index({
  name: 'text',
  description: 'text',
  tags: 'text',
  code: 'text',
});
