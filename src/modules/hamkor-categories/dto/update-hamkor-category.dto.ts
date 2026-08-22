import { PartialType } from '@nestjs/mapped-types';
import { CreateHamkorCategoryDto } from './create-hamkor-category.dto';

export class UpdateHamkorCategoryDto extends PartialType(
  CreateHamkorCategoryDto,
) {}
