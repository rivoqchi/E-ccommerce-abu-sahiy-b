import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type HamkorCategoryDocument = HydratedDocument<HamkorCategory>;

@Schema({ timestamps: true, collection: 'hamkor_categories' })
export class HamkorCategory {
  @Prop({
    type: Types.ObjectId,
    ref: 'HamkorPartner',
    required: true,
    index: true,
  })
  partnerId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, lowercase: true, trim: true })
  slug!: string;

  @Prop()
  image?: string;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ default: 0 })
  sortOrder!: number;
}

export const HamkorCategorySchema =
  SchemaFactory.createForClass(HamkorCategory);
HamkorCategorySchema.index({ partnerId: 1, slug: 1 }, { unique: true });
