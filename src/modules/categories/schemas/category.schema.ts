import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CategoryDocument = HydratedDocument<Category>;

@Schema({ timestamps: true, collection: 'categories' })
export class Category {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string;

  @Prop()
  description?: string;

  /** Storefront circular category thumbnail */
  @Prop()
  image?: string;

  @Prop({ type: Types.ObjectId, ref: 'Category', default: null })
  parentId?: Types.ObjectId | null;

  @Prop()
  metaTitle?: string;

  @Prop()
  metaDescription?: string;

  @Prop()
  ogImage?: string;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ default: 0 })
  sortOrder!: number;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
CategorySchema.index({ parentId: 1, isActive: 1 });
