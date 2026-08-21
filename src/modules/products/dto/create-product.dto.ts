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

export class ProductSpecDto {
  @IsString()
  @MinLength(1)
  label!: string;

  @IsString()
  @MinLength(1)
  value!: string;
}

export class CreateProductDto {
  @IsString()
  @MinLength(2)
  name!: string;

  /** Mahsulot kodi (SKU) */
  @IsString()
  @MinLength(1)
  code!: string;

  /** Shtrix-kod (Smartup ombor sync) */
  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Oddiy narx (USD) */
  @IsNumber()
  @Min(0)
  price!: number;

  /** Optom narx (USD). Berilmasa oddiy narx olinadi. */
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
  categoryId!: string;

  @IsOptional()
  @IsMongoId()
  brandId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Kamida 1 ta rasm yuklash majburiy' })
  @IsString({ each: true })
  images!: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductSpecDto)
  specs?: ProductSpecDto[];

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsString()
  metaTitle?: string;

  @IsOptional()
  @IsString()
  metaDescription?: string;

  @IsOptional()
  @IsString()
  ogImage?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
