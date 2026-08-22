import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  HamkorProduct,
  HamkorProductSchema,
} from './schemas/hamkor-product.schema';
import { HamkorProductsService } from './hamkor-products.service';
import { HamkorProductsController } from './hamkor-products.controller';
import { HamkorCategoriesModule } from '../hamkor-categories/hamkor-categories.module';
import { HamkorPartnersModule } from '../hamkor-partners/hamkor-partners.module';
import { ProductsModule } from '../products/products.module';
import {
  HamkorPartner,
  HamkorPartnerSchema,
} from '../hamkor-partners/schemas/hamkor-partner.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: HamkorProduct.name, schema: HamkorProductSchema },
      { name: HamkorPartner.name, schema: HamkorPartnerSchema },
    ]),
    HamkorCategoriesModule,
    HamkorPartnersModule,
    ProductsModule,
  ],
  controllers: [HamkorProductsController],
  providers: [HamkorProductsService],
  exports: [HamkorProductsService],
})
export class HamkorProductsModule {}
