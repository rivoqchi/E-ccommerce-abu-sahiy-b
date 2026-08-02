import { IsString, Matches, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone must be E.164 format, e.g. +998901234567',
  })
  phone!: string;

  @IsString()
  @Length(4, 8)
  @Matches(/^\d+$/, { message: 'code must be numeric' })
  code!: string;
}
