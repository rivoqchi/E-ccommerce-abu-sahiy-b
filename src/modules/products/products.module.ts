import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import {
  ProductDisplaySettings,
  ProductDisplaySettingsSchema,
} from './schemas/product-display-settings.schema';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ExcelImportService } from './excel-import.service';
import { CategoriesModule } from '../categories/categories.module';
import { BrandsModule } from '../brands/brands.module';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      {
        name: ProductDisplaySettings.name,
        schema: ProductDisplaySettingsSchema,
      },
      { name: Order.name, schema: OrderSchema },
    ]),
    forwardRef(() => CategoriesModule),
    BrandsModule,
    UploadsModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ExcelImportService],
  exports: [ProductsService],
})
export class ProductsModule {}
