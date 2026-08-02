import { IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { SellerStatus } from '../../../common/enums/seller-status.enum';

export class CreateSellerDto {
  @IsString()
  @MinLength(2)
  fullName!: string;

  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/)
  phone!: string;

  @IsOptional()
  @IsEnum(SellerStatus)
  status?: SellerStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
