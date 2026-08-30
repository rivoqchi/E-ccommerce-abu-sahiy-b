import { IsArray, IsIn, IsOptional, IsString, Matches, ArrayMaxSize } from 'class-validator';

const UPLOAD_FOLDERS = ['products', 'xitoy'] as const;

export class UploadImagesDto {
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,/, {
    each: true,
    message: 'each item must be a JPEG, PNG or WebP data URL',
  })
  dataUrls!: string[];

  /** R2/local papka: products (default) yoki xitoy */
  @IsOptional()
  @IsString()
  @IsIn(UPLOAD_FOLDERS)
  folder?: (typeof UPLOAD_FOLDERS)[number];
}
