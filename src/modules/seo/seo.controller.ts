import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SeoService } from './seo.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('seo')
@Public()
export class SeoController {
  constructor(private readonly seoService: SeoService) {}

  @Get('sitemap')
  sitemap() {
    return this.seoService.getSitemap();
  }

  @Get('products/:slug')
  async productMeta(@Param('slug') slug: string) {
    const meta = await this.seoService.getProductMeta(slug);
    if (!meta) {
      throw new NotFoundException('Product SEO meta not found');
    }
    return meta;
  }

  @Get('categories/:slug')
  async categoryMeta(@Param('slug') slug: string) {
    const meta = await this.seoService.getCategoryMeta(slug);
    if (!meta) {
      throw new NotFoundException('Category SEO meta not found');
    }
    return meta;
  }
}
