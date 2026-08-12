import { IsString, MinLength } from 'class-validator';

export class BotWebLoginDto {
  @IsString()
  @MinLength(16)
  token!: string;
}
