import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductDisplaySettingsDocument =
  HydratedDocument<ProductDisplaySettings>;

export const PRODUCT_DISPLAY_SETTINGS_KEY = 'storefront';

@Schema({ timestamps: true, collection: 'product_display_settings' })
export class ProductDisplaySettings {
  @Prop({
    required: true,
    unique: true,
    default: PRODUCT_DISPLAY_SETTINGS_KEY,
  })
  key!: string;

  /** Do‘kon sahifalarida ko‘rinmasligi kerak bo‘lgan maydonlar. */
  @Prop({ type: [String], default: [] })
  hiddenFields!: string[];

  /** Bir xil labeldagi xususiyatlar do‘konda chiqmasin. */
  @Prop({ type: [String], default: [] })
  hiddenSpecLabels!: string[];
}

export const ProductDisplaySettingsSchema = SchemaFactory.createForClass(
  ProductDisplaySettings,
);
