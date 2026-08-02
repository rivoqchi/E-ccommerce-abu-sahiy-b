import { IsArray, IsString, Matches, ArrayMaxSize } from 'class-validator';

export class UploadImagesDto {
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,/, {
    each: true,
    message: 'each item must be a JPEG, PNG or WebP data URL',
  })
  dataUrls!: string[];
}
