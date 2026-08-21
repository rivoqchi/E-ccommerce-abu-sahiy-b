import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { SmartupStockSyncService } from './smartup-stock-sync.service';

@Controller('admin/smartup')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class SmartupController {
  constructor(private readonly syncService: SmartupStockSyncService) {}

  /** Manual trigger — cron asosiy; admin test uchun */
  @Post('sync-stock')
  syncStock() {
    return this.syncService.syncStock();
  }
}
