import { IsString, MinLength } from 'class-validator';

export class TelegramAuthDto {
  @IsString()
  @MinLength(10)
  initData!: string;
}
