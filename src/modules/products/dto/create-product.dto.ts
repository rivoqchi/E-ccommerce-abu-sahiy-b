import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
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

  /** Oddiy narx (USD, legacy). Optom berilsa shunga teng saqlanadi. */
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

  /** Karobkada nechta dona. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  piecesPerBox?: number;

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

  /** Bosh sahifada 30 kun «Yangi mahsulotlar»da ko‘rsatish. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  highlightAsNew?: boolean;
}
