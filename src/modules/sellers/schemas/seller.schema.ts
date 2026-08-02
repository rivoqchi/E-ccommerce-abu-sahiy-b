import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SellerStatus } from '../../../common/enums/seller-status.enum';

export type SellerDocument = HydratedDocument<Seller>;

@Schema({ timestamps: true, collection: 'sellers' })
export class Seller {
  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({ required: true, unique: true, trim: true })
  phone!: string;

  @Prop({ type: String, enum: SellerStatus, default: SellerStatus.Active })
  status!: SellerStatus;

  @Prop({ trim: true })
  notes?: string;
}

export const SellerSchema = SchemaFactory.createForClass(Seller);
SellerSchema.index({ phone: 1 }, { unique: true });
