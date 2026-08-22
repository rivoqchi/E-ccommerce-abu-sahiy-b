import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { HamkorPartnersService } from './hamkor-partners.service';
import { CreateHamkorPartnerDto } from './dto/create-hamkor-partner.dto';
import { UpdateHamkorPartnerDto } from './dto/update-hamkor-partner.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';

@Controller('hamkor/partners')
export class HamkorPartnersController {
  constructor(private readonly partnersService: HamkorPartnersService) {}

  @Public()
  @Get()
  findAll(@Query('all') all?: string) {
    return this.partnersService.findAll(all !== 'true');
  }

  @Public()
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.partnersService.findBySlug(slug);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateHamkorPartnerDto) {
    return this.partnersService.create(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateHamkorPartnerDto) {
    return this.partnersService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.partnersService.remove(id);
  }
}
