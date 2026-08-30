import { PartialType } from '@nestjs/mapped-types';
import { CreateXitoyProductDto } from './create-xitoy-product.dto';

export class UpdateXitoyProductDto extends PartialType(CreateXitoyProductDto) {}
