import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { SetStockDto } from './dto/set-stock.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Patch(':productId')
  setStock(@Param('productId') productId: string, @Body() dto: SetStockDto) {
    return this.inventoryService.setStock(productId, dto.stock);
  }
}
