import { IsNumber, IsString, Min, MinLength } from 'class-validator';

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
  yuanRate!: number;

  @IsNumber()
  @Min(0)
  customsFee!: number;
}
