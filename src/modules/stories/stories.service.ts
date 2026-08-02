import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Story, StoryItem, StoryMediaType } from './schemas/story.schema';
import { CreateStoryDto } from './dto/create-story.dto';
import { UpdateStoryDto } from './dto/update-story.dto';

@Injectable()
export class StoriesService {
  constructor(
    @InjectModel(Story.name) private readonly storyModel: Model<Story>,
  ) {}

  async create(dto: CreateStoryDto) {
    const story = await this.storyModel.create({
      ...dto,
      isActive: dto.isActive ?? true,
    });
    return story.toObject();
  }

  /** Storefront: active stories, newest first */
  async findAll(activeOnly = true) {
    const filter = activeOnly ? { isActive: true } : {};
    return this.storyModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async findOne(id: string) {
    const story = await this.storyModel.findById(id).lean().exec();
    if (!story) throw new NotFoundException('Story not found');
    return story;
  }

  /**
   * Flatten video slides into a reels-style feed (newest stories first).
   */
  async findVideos(activeOnly = true) {
    const stories = await this.findAll(activeOnly);
    const videos: Array<{
      id: string;
      storyId: string;
      authorName: string;
      avatarUrl?: string;
      mediaUrl: string;
      mediaUrlLow?: string;
      thumbnailUrl?: string;
      caption?: string;
      createdAt?: Date;
    }> = [];

    for (const story of stories) {
      for (const item of story.items ?? []) {
        if (item.mediaType !== StoryMediaType.Video) continue;
        const itemId = (item as StoryItem & { _id?: { toString(): string } })
          ._id;
        videos.push({
          id: String(itemId ?? `${story._id}-${item.mediaUrl}`),
          storyId: String(story._id),
          authorName: story.authorName,
          avatarUrl: story.avatarUrl,
          mediaUrl: item.mediaUrl,
          mediaUrlLow: item.mediaUrlLow,
          thumbnailUrl: item.thumbnailUrl,
          caption: item.caption,
          createdAt: (story as { createdAt?: Date }).createdAt,
        });
      }
    }

    return videos;
  }

  async update(id: string, dto: UpdateStoryDto) {
    const story = await this.storyModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .lean()
      .exec();
    if (!story) throw new NotFoundException('Story not found');
    return story;
  }

  async remove(id: string) {
    const result = await this.storyModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Story not found');
    return { deleted: true };
  }
}
