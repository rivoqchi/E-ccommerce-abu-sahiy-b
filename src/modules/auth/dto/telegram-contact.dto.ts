import { IsString, MinLength } from 'class-validator';

/** Signed query string from Telegram.WebApp.requestContact() */
export class TelegramContactDto {
  @IsString()
  @MinLength(10)
  contactData!: string;
}
