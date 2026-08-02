import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Role } from '../../../common/enums/role.enum';
import { PriceTier } from '../../../common/enums/price-tier.enum';

export type UserDocument = HydratedDocument<User>;

@Schema({ _id: false })
export class Address {
  @Prop({ required: true })
  label!: string;

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

  @Prop({ default: false })
  isDefault!: boolean;
}

export const AddressSchema = SchemaFactory.createForClass(Address);

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ unique: true, sparse: true, lowercase: true, trim: true })
  email?: string;

  @Prop()
  passwordHash?: string;

  /** E.164, e.g. +998901234567 */
  @Prop({ unique: true, sparse: true, trim: true })
  phone?: string;

  @Prop({ unique: true, sparse: true })
  telegramId?: string;

  @Prop({ trim: true })
  username?: string;

  @Prop({ trim: true })
  firstName?: string;

  @Prop({ trim: true })
  lastName?: string;

  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({ trim: true })
  avatarUrl?: string;

  @Prop({ type: String, enum: Role, default: Role.Customer })
  role!: Role;

  /** Yangi foydalanuvchi — oddiy narx; admin optomga o'tkazadi */
  @Prop({ type: String, enum: PriceTier, default: PriceTier.Retail })
  priceTier!: PriceTier;

  @Prop({ type: [AddressSchema], default: [] })
  addresses!: Address[];

  @Prop({ default: true })
  isActive!: boolean;

  @Prop()
  refreshTokenHash?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
