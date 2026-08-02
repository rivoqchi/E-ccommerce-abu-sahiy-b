import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { StoryMediaType } from '../schemas/story.schema';

export class CreateStoryItemDto {
  @IsEnum(StoryMediaType)
  mediaType!: StoryMediaType;

  @IsString()
  @MinLength(8)
  mediaUrl!: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  mediaUrlLow?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  thumbnailUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(30_000)
  durationMs?: number;

  @IsOptional()
  @IsString()
  caption?: string;
}

export class CreateStoryDto {
  @IsString()
  @MinLength(1)
  authorName!: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  avatarUrl?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateStoryItemDto)
  items!: CreateStoryItemDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
