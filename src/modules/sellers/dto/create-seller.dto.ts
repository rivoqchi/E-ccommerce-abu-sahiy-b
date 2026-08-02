import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { SellerStatus } from '../../../common/enums/seller-status.enum';

export class CreateSellerDto {
  @IsString()
  @MinLength(2)
  fullName!: string;

  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/)
  phone!: string;

  @IsOptional()
  @IsString()
  @Matches(/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/, {
    message: 'telegramUsername must be a valid Telegram username',
  })
  telegramUsername?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  avatarUrl?: string;

  @IsOptional()
  @IsEnum(SellerStatus)
  status?: SellerStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
