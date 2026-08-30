import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { CreateXitoyProductDto } from './dto/create-xitoy-product.dto';
import { UpdateXitoyProductDto } from './dto/update-xitoy-product.dto';
import { XitoyProductsService } from './xitoy-products.service';

@Controller('admin/xitoy-products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class XitoyProductsController {
  constructor(private readonly xitoyProductsService: XitoyProductsService) {}

  @Get()
  findAll() {
    return this.xitoyProductsService.findAll();
  }

  @Post()
  create(@Body() dto: CreateXitoyProductDto) {
    return this.xitoyProductsService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateXitoyProductDto) {
    return this.xitoyProductsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.xitoyProductsService.remove(id);
  }
}
