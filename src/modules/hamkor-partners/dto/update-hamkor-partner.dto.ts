import { PartialType } from '@nestjs/mapped-types';
import { CreateHamkorPartnerDto } from './create-hamkor-partner.dto';

export class UpdateHamkorPartnerDto extends PartialType(
  CreateHamkorPartnerDto,
) {}
