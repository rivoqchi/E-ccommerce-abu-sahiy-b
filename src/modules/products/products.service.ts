import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Product } from './schemas/product.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { slugify } from '../../common/utils/slugify';
import { RedisService } from '../redis/redis.service';
import { ProductStatus } from '../../common/enums/product-status.enum';
import { CategoriesService } from '../categories/categories.service';
import { BrandsService } from '../brands/brands.service';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly categoriesService: CategoriesService,
    private readonly brandsService: BrandsService,
  ) {}

  async create(dto: CreateProductDto) {
    await this.categoriesService.findById(dto.categoryId);
    if (dto.brandId) {
      await this.brandsService.findById(dto.brandId);
    }

    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    const exists = await this.productModel.exists({ slug });
    if (exists) {
      throw new ConflictException('Product slug already exists');
    }

    const product = await this.productModel.create({
      ...dto,
      description: dto.description?.trim() || dto.name,
      slug,
      categoryId: new Types.ObjectId(dto.categoryId),
      brandId: dto.brandId ? new Types.ObjectId(dto.brandId) : undefined,
      specs: dto.specs ?? [],
      images: dto.images ?? [],
      status: dto.status ?? ProductStatus.Active,
      isActive: true,
    });

    await this.invalidateCache(product._id.toString(), slug);
    return product.toObject();
  }

  async findAll(query: QueryProductsDto) {
    const limit = query.limit ?? 20;
    const cacheKey = `products:list:${JSON.stringify(query)}`;
    const cached = await this.redis.getJson<{
      items: unknown[];
      nextCursor: string | null;
    }>(cacheKey);
    if (cached) return cached;

    const filter: Record<string, unknown> = {
      status: ProductStatus.Active,
      isActive: true,
    };

    if (query.categoryId) {
      filter.categoryId = new Types.ObjectId(query.categoryId);
    }

    if (query.q) {
      filter.$text = { $search: query.q };
    }

    if (query.cursor) {
      filter._id = { $lt: new Types.ObjectId(query.cursor) };
    }

    const items = await this.productModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .lean()
      .exec();

    const nextCursor =
      items.length === limit
        ? (items[items.length - 1] as { _id: Types.ObjectId })._id.toString()
        : null;

    const result = { items, nextCursor };
    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, result, ttl);
    return result;
  }

  async findAllAdmin() {
    return this.productModel.find().sort({ createdAt: -1 }).lean().exec();
  }

  async findBySlug(slug: string) {
    const cacheKey = `products:slug:${slug}`;
    const cached = await this.redis.getJson<unknown>(cacheKey);
    if (cached) return cached;

    const product = await this.productModel
      .findOne({ slug, isActive: true })
      .lean()
      .exec();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, product, ttl);
    return product;
  }

  async findById(id: string) {
    const product = await this.productModel.findById(id).lean().exec();
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async update(id: string, dto: UpdateProductDto) {
    if (dto.categoryId) {
      await this.categoriesService.findById(dto.categoryId);
    }
    if (dto.brandId) {
      await this.brandsService.findById(dto.brandId);
    }

    if (dto.slug) {
      dto.slug = slugify(dto.slug);
    } else if (dto.name) {
      dto.slug = slugify(dto.name);
    }

    const updatePayload: Record<string, unknown> = { ...dto };
    if (dto.categoryId) {
      updatePayload.categoryId = new Types.ObjectId(dto.categoryId);
    }
    if (dto.brandId) {
      updatePayload.brandId = new Types.ObjectId(dto.brandId);
    }

    const product = await this.productModel
      .findByIdAndUpdate(id, { $set: updatePayload }, { new: true })
      .lean()
      .exec();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    await this.invalidateCache(id, product.slug);
    return product;
  }

  async remove(id: string) {
    const product = await this.productModel.findByIdAndDelete(id).exec();
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    await this.invalidateCache(id, product.slug);
    return { deleted: true };
  }

  async adjustStock(productId: string, delta: number) {
    const product = await this.productModel
      .findOneAndUpdate(
        {
          _id: productId,
          ...(delta < 0 ? { stock: { $gte: Math.abs(delta) } } : {}),
        },
        { $inc: { stock: delta } },
        { new: true },
      )
      .lean()
      .exec();

    if (!product) {
      throw new ConflictException('Insufficient stock or product not found');
    }

    await this.invalidateCache(productId, product.slug);
    return product;
  }

  async countLowStock(threshold: number) {
    return this.productModel
      .countDocuments({
        isActive: true,
        stock: { $lte: threshold },
      })
      .exec();
  }

  async countAll() {
    return this.productModel.countDocuments().exec();
  }

  private async invalidateCache(productId: string, slug?: string) {
    await this.redis.delByPattern('products:list:*');
    await this.redis.del(`products:id:${productId}`);
    if (slug) {
      await this.redis.del(`products:slug:${slug}`);
    }
    await this.redis.delByPattern('seo:*');
  }
}
