import { Module } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';
import { R2StorageService } from './r2-storage.service';

@Module({
  controllers: [UploadsController],
  providers: [R2StorageService, UploadsService],
  exports: [R2StorageService, UploadsService],
})
export class UploadsModule {}
