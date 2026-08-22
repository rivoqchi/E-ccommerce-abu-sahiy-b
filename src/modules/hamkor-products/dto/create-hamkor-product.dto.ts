import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductStatus } from '../../../common/enums/product-status.enum';

export class HamkorProductSpecDto {
  @IsString()
  @MinLength(1)
  label!: string;

  @IsString()
  @MinLength(1)
  value!: string;
}

export class CreateHamkorProductDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @MinLength(1)
  code!: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  wholesalePrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  compareAtPrice?: number;

  @IsNumber()
  @Min(0)
  stock!: number;

  @IsMongoId()
  partnerId!: string;

  @IsMongoId()
  categoryId!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Kamida 1 ta rasm yuklash majburiy' })
  @IsString({ each: true })
  images!: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HamkorProductSpecDto)
  specs?: HamkorProductSpecDto[];

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
