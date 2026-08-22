import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductSource } from '../../../common/enums/product-source.enum';

export class OrderSubstituteDto {
  @IsMongoId()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsEnum(ProductSource)
  source?: ProductSource;
}

export class OrderFulfillmentItemDto {
  @IsInt()
  @Min(0)
  givenQuantity!: number;

  @IsOptional()
  @IsBoolean()
  unavailable?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OrderSubstituteDto)
  substitutes?: OrderSubstituteDto[];
}

export class UpdateOrderFulfillmentDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderFulfillmentItemDto)
  items!: OrderFulfillmentItemDto[];
}
