import { ArrayMaxSize, IsArray, IsIn, IsString, MaxLength } from 'class-validator';
import {
  MAX_HIDDEN_SPEC_LABELS,
  MAX_SPEC_LABEL_LENGTH,
  PRODUCT_DISPLAY_FIELDS,
  type ProductDisplayField,
} from '../product-display-fields';

export class UpdateProductDisplaySettingsDto {
  @IsArray()
  @IsIn([...PRODUCT_DISPLAY_FIELDS], { each: true })
  hiddenFields!: ProductDisplayField[];

  @IsArray()
  @IsString({ each: true })
  @MaxLength(MAX_SPEC_LABEL_LENGTH, { each: true })
  @ArrayMaxSize(MAX_HIDDEN_SPEC_LABELS)
  hiddenSpecLabels!: string[];
}
