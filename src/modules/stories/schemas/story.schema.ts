import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoryDocument = HydratedDocument<Story>;

export enum StoryMediaType {
  Image = 'image',
  Video = 'video',
}

@Schema({ _id: true })
export class StoryItem {
  @Prop({ required: true, type: String, enum: StoryMediaType })
  mediaType!: StoryMediaType;

  /** Full / high quality media URL */
  @Prop({ required: true, trim: true })
  mediaUrl!: string;

  /** Optional compressed URL for data-saver / low quality */
  @Prop({ trim: true })
  mediaUrlLow?: string;

  @Prop({ trim: true })
  thumbnailUrl?: string;

  /** Image slide duration (ms). Videos use natural length. */
  @Prop({ default: 5000, min: 1000, max: 30_000 })
  durationMs?: number;

  @Prop({ trim: true })
  caption?: string;
}

export const StoryItemSchema = SchemaFactory.createForClass(StoryItem);

@Schema({ timestamps: true, collection: 'stories' })
export class Story {
  @Prop({ required: true, trim: true })
  authorName!: string;

  @Prop({ trim: true })
  avatarUrl?: string;

  @Prop({ type: [StoryItemSchema], default: [] })
  items!: StoryItem[];

  @Prop({ default: true })
  isActive!: boolean;
}

export const StorySchema = SchemaFactory.createForClass(Story);
StorySchema.index({ isActive: 1, createdAt: -1 });
StorySchema.index({ updatedAt: -1 });
