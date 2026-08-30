import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Min, ValidateNested } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
import { StockAdjustDto } from './stock-adjust.dto';

/**
 * PartialType ba'zan yangi maydonlarni whitelistga qo'shmaydi (forbidNonWhitelisted).
 * piecesPerBox va stockAdjust alohida e'lon qilinadi.
 */
export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['piecesPerBox'] as const),
) {
  @IsOptional()
  @IsNumber()
  @Min(1)
  piecesPerBox?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => StockAdjustDto)
  stockAdjust?: StockAdjustDto;
}
