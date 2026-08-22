import { PartialType } from '@nestjs/mapped-types';
import { CreateHamkorProductDto } from './create-hamkor-product.dto';

export class UpdateHamkorProductDto extends PartialType(
  CreateHamkorProductDto,
) {}
