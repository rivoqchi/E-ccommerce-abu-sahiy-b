import { IsInt, IsOptional } from 'class-validator';

export class StockAdjustDto {
  /** Qo'shiladigan karobka soni (manfiy — ayirish). */
  @IsOptional()
  @IsInt()
  boxAmount?: number;

  /** Qo'shiladigan dona soni (manfiy — ayirish). */
  @IsOptional()
  @IsInt()
  pieceAmount?: number;
}
