import {
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { UploadsService, VIDEO_MAX_BYTES } from './uploads.service';
import { UploadImagesDto } from './dto/upload-images.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';

const TMP_DIR = join(process.cwd(), 'uploads', 'tmp');

@Controller('uploads')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('images')
  async uploadImages(@Body() dto: UploadImagesDto) {
    const urls = await this.uploadsService.saveImages(
      dto.dataUrls,
      dto.folder ?? 'products',
    );
    return { urls };
  }

  /**
   * Multipart upload for story images/videos (up to ~200MB).
   * Streams to disk (not RAM). Field name: `file`
   */
  @Post('media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(TMP_DIR, { recursive: true });
          cb(null, TMP_DIR);
        },
        filename: (_req, file, cb) => {
          const safe = (file.originalname || 'media').replace(
            /[^a-zA-Z0-9._-]/g,
            '_',
          );
          cb(null, `${randomUUID()}-${safe}`);
        },
      }),
      limits: { fileSize: VIDEO_MAX_BYTES },
    }),
  )
  async uploadMedia(@UploadedFile() file: Express.Multer.File) {
    return this.uploadsService.saveUploadedMedia(file);
  }
}
