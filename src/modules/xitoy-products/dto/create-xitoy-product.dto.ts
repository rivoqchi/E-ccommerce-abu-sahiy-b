import { IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export enum YuanRateUnitDto {
  Yuan = 'yuan',
  Usd = 'usd',
}

export class CreateXitoyProductDto {
  @IsString()
  @MinLength(1)
  imageUrl!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsNumber()
  @Min(0)
  chinaPriceYuan!: number;

  @IsNumber()
  @Min(0)
  cubicM3!: number;

  @IsNumber()
  @Min(0)
  weightKg!: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  yuanRate?: number;

  @IsEnum(YuanRateUnitDto)
  @IsOptional()
  yuanRateUnit?: YuanRateUnitDto;

  @IsNumber()
  @Min(0)
  customsFee!: number;
}
