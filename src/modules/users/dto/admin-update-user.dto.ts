import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { Role } from '../../../common/enums/role.enum';
import { PriceTier } from '../../../common/enums/price-tier.enum';
import { ApprovalStatus } from '../../../common/enums/approval-status.enum';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsEnum(PriceTier)
  priceTier?: PriceTier;

  @IsOptional()
  @IsEnum(ApprovalStatus)
  approvalStatus?: ApprovalStatus;
}
