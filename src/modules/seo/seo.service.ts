import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Product } from '../products/schemas/product.schema';
import { Category } from '../categories/schemas/category.schema';
import { ProductStatus } from '../../common/enums/product-status.enum';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class SeoService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    @InjectModel(Category.name) private readonly categoryModel: Model<Category>,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async getSitemap() {
    const cacheKey = 'seo:sitemap';
    const cached = await this.redis.getJson<unknown>(cacheKey);
    if (cached) return cached;

    const [products, categories] = await Promise.all([
      this.productModel
        .find({ status: ProductStatus.Active, isActive: true })
        .select('slug updatedAt metaTitle')
        .lean()
        .exec(),
      this.categoryModel
        .find({ isActive: true })
        .select('slug updatedAt metaTitle')
        .lean()
        .exec(),
    ]);

    const payload = {
      generatedAt: new Date().toISOString(),
      urls: [
        ...categories.map((category) => ({
          type: 'category' as const,
          loc: `/categories/${category.slug}`,
          slug: category.slug,
          updatedAt: (category as { updatedAt?: Date }).updatedAt,
        })),
        ...products.map((product) => ({
          type: 'product' as const,
          loc: `/products/${product.slug}`,
          slug: product.slug,
          updatedAt: (product as { updatedAt?: Date }).updatedAt,
        })),
      ],
    };

    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, payload, ttl);
    return payload;
  }

  async getProductMeta(slug: string) {
    const cacheKey = `seo:product:${slug}`;
    const cached = await this.redis.getJson<unknown>(cacheKey);
    if (cached) return cached;

    const product = await this.productModel
      .findOne({ slug, isActive: true })
      .select('name slug metaTitle metaDescription ogImage images description')
      .lean()
      .exec();

    if (!product) {
      return null;
    }

    const meta = {
      title: product.metaTitle || product.name,
      description:
        product.metaDescription || product.description.slice(0, 160),
      ogImage: product.ogImage || product.images?.[0] || null,
      canonicalPath: `/products/${product.slug}`,
      slug: product.slug,
    };

    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, meta, ttl);
    return meta;
  }

  async getCategoryMeta(slug: string) {
    const cacheKey = `seo:category:${slug}`;
    const cached = await this.redis.getJson<unknown>(cacheKey);
    if (cached) return cached;

    const category = await this.categoryModel
      .findOne({ slug, isActive: true })
      .select('name slug metaTitle metaDescription ogImage description')
      .lean()
      .exec();

    if (!category) {
      return null;
    }

    const meta = {
      title: category.metaTitle || category.name,
      description:
        category.metaDescription ||
        category.description?.slice(0, 160) ||
        category.name,
      ogImage: category.ogImage || null,
      canonicalPath: `/categories/${category.slug}`,
      slug: category.slug,
    };

    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, meta, ttl);
    return meta;
  }
}
