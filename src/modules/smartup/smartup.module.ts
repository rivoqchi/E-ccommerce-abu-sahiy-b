import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';
import { SmartupApiClient } from './smartup-api.client';
import { SmartupController } from './smartup.controller';
import { SmartupStockSyncService } from './smartup-stock-sync.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ProductsModule,
    InventoryModule,
  ],
  controllers: [SmartupController],
  providers: [SmartupApiClient, SmartupStockSyncService],
  exports: [SmartupStockSyncService, SmartupApiClient],
})
export class SmartupModule {}
