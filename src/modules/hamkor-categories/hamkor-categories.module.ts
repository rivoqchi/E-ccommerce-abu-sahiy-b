import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  HamkorCategory,
  HamkorCategorySchema,
} from './schemas/hamkor-category.schema';
import {
  HamkorProduct,
  HamkorProductSchema,
} from '../hamkor-products/schemas/hamkor-product.schema';
import { HamkorCategoriesService } from './hamkor-categories.service';
import { HamkorCategoriesController } from './hamkor-categories.controller';
import { HamkorPartnersModule } from '../hamkor-partners/hamkor-partners.module';
import {
  HamkorPartner,
  HamkorPartnerSchema,
} from '../hamkor-partners/schemas/hamkor-partner.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: HamkorCategory.name, schema: HamkorCategorySchema },
      { name: HamkorProduct.name, schema: HamkorProductSchema },
      { name: HamkorPartner.name, schema: HamkorPartnerSchema },
    ]),
    HamkorPartnersModule,
  ],
  controllers: [HamkorCategoriesController],
  providers: [HamkorCategoriesService],
  exports: [HamkorCategoriesService],
})
export class HamkorCategoriesModule {}
