import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { diskStorage } from 'multer';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ProductsService } from './products.service';
import {
  ExcelImportService,
  EXCEL_IMPORT_MAX_BYTES,
} from './excel-import.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { QueryAdminProductsDto } from './dto/query-admin-products.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';

const EXCEL_TMP_DIR = join(process.cwd(), 'uploads', 'tmp');

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly excelImportService: ExcelImportService,
  ) {}

  @Public()
  @Get()
  findAll(@Query() query: QueryProductsDto) {
    return this.productsService.findAll(query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Get('admin/all')
  findAllAdmin(@Query() query: QueryAdminProductsDto) {
    return this.productsService.findAllAdmin(
      query.page ?? 1,
      query.limit ?? 100,
      query.q,
      query.incomplete,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @SkipThrottle()
  @Post('import-excel')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(EXCEL_TMP_DIR, { recursive: true });
          cb(null, EXCEL_TMP_DIR);
        },
        filename: (_req, file, cb) => {
          const safe = (file.originalname || 'import.xlsx').replace(
            /[^a-zA-Z0-9._-]/g,
            '_',
          );
          cb(null, `${randomUUID()}-${safe}`);
        },
      }),
      limits: { fileSize: EXCEL_IMPORT_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        const ok =
          name.endsWith('.xlsx') ||
          file.mimetype ===
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          file.mimetype === 'application/octet-stream';
        if (!ok) {
          cb(
            new BadRequestException(
              'Faqat .xlsx format qabul qilinadi',
            ) as unknown as Error,
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  importExcel(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
    @Query('replace') replaceQuery?: string,
    @Body('replace') replaceBody?: string,
  ) {
    // multipart body ba’zan @Body orqali kelmaydi — query + req.body ikkalasi
    const raw = String(
      replaceQuery ??
        replaceBody ??
        (req.body as { replace?: string } | undefined)?.replace ??
        '',
    )
      .trim()
      .toLowerCase();
    const replaceAll = raw === 'true' || raw === '1' || raw === 'yes';
    return this.excelImportService.importFromUpload(file, {
      replace: replaceAll,
    });
  }

  @Public()
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productsService.remove(id);
  }
}
