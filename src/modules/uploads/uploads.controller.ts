import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { UploadImagesDto } from './dto/upload-images.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';

@Controller('uploads')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('images')
  async uploadImages(@Body() dto: UploadImagesDto) {
    const urls = await this.uploadsService.saveImages(dto.dataUrls);
    return { urls };
  }
}
