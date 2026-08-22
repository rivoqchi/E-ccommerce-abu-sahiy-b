import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  HamkorPartner,
  HamkorPartnerSchema,
} from './schemas/hamkor-partner.schema';
import { HamkorPartnersService } from './hamkor-partners.service';
import { HamkorPartnersController } from './hamkor-partners.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: HamkorPartner.name, schema: HamkorPartnerSchema },
    ]),
  ],
  controllers: [HamkorPartnersController],
  providers: [HamkorPartnersService],
  exports: [HamkorPartnersService],
})
export class HamkorPartnersModule {}
