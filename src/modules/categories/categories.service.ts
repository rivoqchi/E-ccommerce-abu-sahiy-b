import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Category } from './schemas/category.schema';
import { Product } from '../products/schemas/product.schema';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ProductStatus } from '../../common/enums/product-status.enum';
import { slugify } from '../../common/utils/slugify';
import { RedisService } from '../redis/redis.service';

const LIST_CACHE_KEY = 'categories:list';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectModel(Category.name) private readonly categoryModel: Model<Category>,
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async create(dto: CreateCategoryDto) {
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    const exists = await this.categoryModel.exists({ slug });
    if (exists) {
      throw new ConflictException('Category slug already exists');
    }

    const category = await this.categoryModel.create({
      ...dto,
      slug,
      parentId: dto.parentId ?? null,
    });

    await this.invalidateCache();
    return category.toObject();
  }

  async findAll(activeOnly = true) {
    const cacheKey = `${LIST_CACHE_KEY}:${activeOnly ? 'active' : 'all'}:counts`;
    const cached = await this.redis.getJson<unknown[]>(cacheKey);
    if (cached) return cached;

    const filter = activeOnly ? { isActive: true } : {};
    const categories = await this.categoryModel
      .aggregate([
        { $match: filter },
        { $sort: { sortOrder: 1, name: 1 } },
        {
          $lookup: {
            from: this.productModel.collection.name,
            let: { categoryId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$categoryId', '$$categoryId'] },
                  status: ProductStatus.Active,
                  isActive: true,
                },
              },
              { $count: 'count' },
            ],
            as: 'productStats',
          },
        },
        {
          $addFields: {
            productCount: {
              $ifNull: [{ $arrayElemAt: ['$productStats.count', 0] }, 0],
            },
          },
        },
        { $project: { productStats: 0 } },
      ])
      .exec();

    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, categories, ttl);
    return categories;
  }

  async findBySlug(slug: string) {
    const category = await this.categoryModel.findOne({ slug }).lean().exec();
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  async findById(id: string) {
    const category = await this.categoryModel.findById(id).lean().exec();
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    if (dto.slug) {
      dto.slug = slugify(dto.slug);
    } else if (dto.name) {
      dto.slug = slugify(dto.name);
    }

    const category = await this.categoryModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .lean()
      .exec();

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    await this.invalidateCache();
    return category;
  }

  async remove(id: string) {
    const result = await this.categoryModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException('Category not found');
    }
    await this.invalidateCache();
    return { deleted: true };
  }

  private async invalidateCache() {
    await this.redis.delByPattern('categories:*');
  }
}
