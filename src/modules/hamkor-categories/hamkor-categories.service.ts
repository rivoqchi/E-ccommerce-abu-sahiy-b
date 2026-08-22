import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { HamkorCategory } from './schemas/hamkor-category.schema';
import { HamkorProduct } from '../hamkor-products/schemas/hamkor-product.schema';
import { CreateHamkorCategoryDto } from './dto/create-hamkor-category.dto';
import { UpdateHamkorCategoryDto } from './dto/update-hamkor-category.dto';
import { ProductStatus } from '../../common/enums/product-status.enum';
import { slugify } from '../../common/utils/slugify';
import { RedisService } from '../redis/redis.service';
import { storefrontReadyMongoFilter } from '../products/product-completeness';
import { HamkorPartnersService } from '../hamkor-partners/hamkor-partners.service';

const LIST_CACHE_KEY = 'hamkor:categories:list';

@Injectable()
export class HamkorCategoriesService {
  constructor(
    @InjectModel(HamkorCategory.name)
    private readonly categoryModel: Model<HamkorCategory>,
    @InjectModel(HamkorProduct.name)
    private readonly productModel: Model<HamkorProduct>,
    private readonly partnersService: HamkorPartnersService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async create(dto: CreateHamkorCategoryDto) {
    await this.partnersService.findById(dto.partnerId);
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    const exists = await this.categoryModel.exists({
      slug,
      partnerId: dto.partnerId,
    });
    if (exists) {
      throw new ConflictException('Category slug already exists');
    }

    const category = await this.categoryModel.create({
      ...dto,
      partnerId: new Types.ObjectId(dto.partnerId),
      slug,
    });

    await this.invalidateCache();
    return category.toObject();
  }

  async findAll(activeOnly = true, partnerId?: string) {
    const cacheKey = `${LIST_CACHE_KEY}:${activeOnly ? 'active' : 'all'}:${partnerId ?? 'any'}:counts:ready`;
    const cached = await this.redis.getJson<unknown[]>(cacheKey);
    if (cached) return cached;

    const filter: Record<string, unknown> = activeOnly ? { isActive: true } : {};
    if (partnerId) {
      filter.partnerId = new Types.ObjectId(partnerId);
    }
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
                  ...storefrontReadyMongoFilter(),
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
        {
          $lookup: {
            from: 'hamkor_partners',
            localField: 'partnerId',
            foreignField: '_id',
            as: 'partner',
          },
        },
        {
          $addFields: {
            partnerId: {
              $let: {
                vars: { p: { $arrayElemAt: ['$partner', 0] } },
                in: {
                  $cond: [
                    { $ifNull: ['$$p', false] },
                    {
                      _id: '$$p._id',
                      name: '$$p.name',
                      slug: '$$p.slug',
                      image: '$$p.image',
                    },
                    '$partnerId',
                  ],
                },
              },
            },
          },
        },
        { $project: { partner: 0 } },
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

  async update(id: string, dto: UpdateHamkorCategoryDto) {
    if (dto.partnerId) {
      await this.partnersService.findById(dto.partnerId);
    }
    if (dto.slug) {
      dto.slug = slugify(dto.slug);
    } else if (dto.name) {
      dto.slug = slugify(dto.name);
    }

    const $set: Record<string, unknown> = { ...dto };
    if (dto.partnerId) {
      $set.partnerId = new Types.ObjectId(dto.partnerId);
    }

    const category = await this.categoryModel
      .findByIdAndUpdate(id, { $set }, { new: true })
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
    await this.redis.delByPattern('hamkor:categories:*');
  }
}
