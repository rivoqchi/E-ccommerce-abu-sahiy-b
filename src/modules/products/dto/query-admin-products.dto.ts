import { IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryAdminProductsDto {
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit?: number = 100;

  @IsOptional()
  @IsString()
  q?: string;
}
