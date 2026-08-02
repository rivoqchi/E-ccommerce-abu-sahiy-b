import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateAvatarDto {
  /** data:image/jpeg;base64,... or data:image/png;base64,... */
  @IsString()
  @MinLength(32)
  @MaxLength(2_500_000)
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,/, {
    message: 'avatar must be a JPEG, PNG or WebP data URL',
  })
  dataUrl!: string;
}
