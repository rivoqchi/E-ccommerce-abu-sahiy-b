import { IsString, Matches, Length } from 'class-validator';

/** E.164 phone, e.g. +998901234567 */
export class SendOtpDto {
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone must be E.164 format, e.g. +998901234567',
  })
  phone!: string;
}
