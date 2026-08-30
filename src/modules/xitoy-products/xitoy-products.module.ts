import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  XitoyProduct,
  XitoyProductSchema,
} from './schemas/xitoy-product.schema';
import { XitoyProductsController } from './xitoy-products.controller';
import { XitoyProductsService } from './xitoy-products.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: XitoyProduct.name, schema: XitoyProductSchema },
    ]),
  ],
  controllers: [XitoyProductsController],
  providers: [XitoyProductsService],
  exports: [XitoyProductsService],
})
export class XitoyProductsModule {}
