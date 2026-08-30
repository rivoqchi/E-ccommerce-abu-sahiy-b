import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Min, ValidateNested } from 'class-validator';
import { CreateHamkorProductDto } from './create-hamkor-product.dto';
import { StockAdjustDto } from '../../products/dto/stock-adjust.dto';

export class UpdateHamkorProductDto extends PartialType(
  OmitType(CreateHamkorProductDto, ['piecesPerBox'] as const),
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
