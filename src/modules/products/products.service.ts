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
import { Order } from '../orders/schemas/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
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
    const page = query.page && query.page > 0 ? query.page : 1;
    const useOffset = Boolean(query.page) && !query.cursor;
    const cacheKey = `products:list:${JSON.stringify(query)}`;
    const cached = await this.redis.getJson<{
      items: unknown[];
      nextCursor: string | null;
      total: number;
      page: number;
      totalPages: number;
    }>(cacheKey);
    if (cached) return cached;

    const filter: Record<string, unknown> = {
      status: ProductStatus.Active,
      isActive: true,
    };

    if (query.categoryId) {
      filter.categoryId = new Types.ObjectId(query.categoryId);
    }

    if (query.brandId) {
      filter.brandId = new Types.ObjectId(query.brandId);
    }

    if (query.q) {
      filter.$text = { $search: query.q };
    }

    const total = await this.productModel.countDocuments(filter).exec();

    if (query.cursor) {
      filter._id = { $lt: new Types.ObjectId(query.cursor) };
    }

    const skip = useOffset ? (page - 1) * limit : 0;

    const items = await this.productModel
      .find(filter)
      .populate('categoryId', 'name slug')
      .populate('brandId', 'name slug')
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const nextCursor =
      !useOffset && items.length === limit
        ? (items[items.length - 1] as { _id: Types.ObjectId })._id.toString()
        : null;

    const result = {
      items,
      nextCursor,
      total,
      page: useOffset ? page : 1,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, result, ttl);
    return result;
  }

  async findAllAdmin() {
    return this.productModel.find().sort({ createdAt: -1 }).lean().exec();
  }

  async findBySlug(slug: string) {
    const cacheKey = `products:slug:${slug}`;
    let product = await this.redis.getJson<Record<string, unknown>>(cacheKey);

    if (!product) {
      const found = await this.productModel
        .findOne({ slug, isActive: true })
        .populate('categoryId', 'name slug')
        .populate('brandId', 'name slug')
        .lean()
        .exec();

      if (!found) {
        throw new NotFoundException('Product not found');
      }

      product = found as unknown as Record<string, unknown>;
      const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
      await this.redis.setJson(cacheKey, product, ttl);
    }

    const productId = String(
      (product as { _id?: Types.ObjectId | string })._id ?? '',
    );
    const purchaseStats = await this.getBuyerStats(productId);

    return {
      ...product,
      buyerCount: purchaseStats.buyerCount,
      recentBuyers: purchaseStats.recentBuyers,
    };
  }

  private async getBuyerStats(productId: string) {
    if (!Types.ObjectId.isValid(productId)) {
      return {
        buyerCount: 0,
        recentBuyers: [] as Array<{ fullName: string; avatarUrl?: string }>,
      };
    }

    const paidStatuses = [
      OrderStatus.Paid,
      OrderStatus.Shipped,
      OrderStatus.Delivered,
    ];
    const productObjectId = new Types.ObjectId(productId);

    const [countRow, recentBuyers] = await Promise.all([
      this.orderModel
        .aggregate<{ buyerCount: number }>([
          {
            $match: {
              status: { $in: paidStatuses },
              'items.productId': productObjectId,
            },
          },
          { $group: { _id: '$userId' } },
          { $count: 'buyerCount' },
        ])
        .exec(),
      this.orderModel
        .aggregate<{ fullName: string; avatarUrl?: string }>([
          {
            $match: {
              status: { $in: paidStatuses },
              'items.productId': productObjectId,
            },
          },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$userId',
              lastAt: { $first: '$createdAt' },
            },
          },
          { $sort: { lastAt: -1 } },
          { $limit: 3 },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'user',
            },
          },
          { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              fullName: { $ifNull: ['$user.fullName', 'Xaridor'] },
              avatarUrl: '$user.avatarUrl',
            },
          },
        ])
        .exec(),
    ]);

    return {
      buyerCount: countRow[0]?.buyerCount ?? 0,
      recentBuyers,
    };
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
