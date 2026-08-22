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
import { HamkorProductsService } from './hamkor-products.service';
import { CreateHamkorProductDto } from './dto/create-hamkor-product.dto';
import { UpdateHamkorProductDto } from './dto/update-hamkor-product.dto';
import { QueryHamkorProductsDto } from './dto/query-hamkor-products.dto';
import { QueryAdminHamkorProductsDto } from './dto/query-admin-hamkor-products.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';

@Controller('hamkor/products')
export class HamkorProductsController {
  constructor(private readonly productsService: HamkorProductsService) {}

  @Public()
  @Get()
  findAll(@Query() query: QueryHamkorProductsDto) {
    return this.productsService.findAll(query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Get('admin/all')
  findAllAdmin(@Query() query: QueryAdminHamkorProductsDto) {
    return this.productsService.findAllAdmin(
      query.page ?? 1,
      query.limit ?? 100,
      query.q,
      query.incomplete,
    );
  }

  @Public()
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateHamkorProductDto) {
    return this.productsService.create(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateHamkorProductDto) {
    return this.productsService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productsService.remove(id);
  }
}
