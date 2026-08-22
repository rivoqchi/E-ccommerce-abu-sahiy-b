import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type HamkorPartnerDocument = HydratedDocument<HamkorPartner>;

@Schema({ timestamps: true, collection: 'hamkor_partners' })
export class HamkorPartner {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string;

  @Prop()
  image?: string;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ default: 0 })
  sortOrder!: number;
}

export const HamkorPartnerSchema = SchemaFactory.createForClass(HamkorPartner);
HamkorPartnerSchema.index({ name: 1 });
