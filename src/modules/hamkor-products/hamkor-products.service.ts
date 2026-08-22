import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { HamkorProduct } from './schemas/hamkor-product.schema';
import { CreateHamkorProductDto } from './dto/create-hamkor-product.dto';
import { UpdateHamkorProductDto } from './dto/update-hamkor-product.dto';
import { QueryHamkorProductsDto } from './dto/query-hamkor-products.dto';
import { slugify } from '../../common/utils/slugify';
import { RedisService } from '../redis/redis.service';
import { ProductStatus } from '../../common/enums/product-status.enum';
import { HamkorCategoriesService } from '../hamkor-categories/hamkor-categories.service';
import { HamkorPartnersService } from '../hamkor-partners/hamkor-partners.service';
import {
  incompleteProductMongoFilter,
  isStorefrontReadyProduct,
  storefrontReadyMongoFilter,
} from '../products/product-completeness';
import { maskStorefrontProduct } from '../products/product-display-fields';
import { ProductsService } from '../products/products.service';

@Injectable()
export class HamkorProductsService {
  constructor(
    @InjectModel(HamkorProduct.name)
    private readonly productModel: Model<HamkorProduct>,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly categoriesService: HamkorCategoriesService,
    private readonly partnersService: HamkorPartnersService,
    private readonly productsService: ProductsService,
  ) {}

  async create(dto: CreateHamkorProductDto) {
    await this.partnersService.findById(dto.partnerId);
    const category = await this.categoriesService.findById(dto.categoryId);
    if (String(category.partnerId) !== dto.partnerId) {
      throw new ConflictException(
        'Kategoriya tanlangan hamkorga tegishli emas',
      );
    }

    const code = dto.code.trim().toUpperCase();
    const codeExists = await this.productModel.exists({ code });
    if (codeExists) {
      throw new ConflictException('Bu mahsulot kodi allaqachon mavjud');
    }

    const slug = await this.buildUniqueSlug(
      dto.slug ? slugify(dto.slug) : slugify(code) || slugify(dto.name),
    );

    const product = await this.productModel.create({
      ...dto,
      code,
      description: dto.description?.trim() || dto.name,
      slug,
      price: dto.price,
      wholesalePrice:
        dto.wholesalePrice !== undefined ? dto.wholesalePrice : dto.price,
      partnerId: new Types.ObjectId(dto.partnerId),
      categoryId: new Types.ObjectId(dto.categoryId),
      specs: dto.specs ?? [],
      images: dto.images ?? [],
      status: dto.status ?? ProductStatus.Active,
      isActive: true,
    });

    await this.invalidateCache(product._id.toString(), slug);
    return product.toObject();
  }

  async findAll(query: QueryHamkorProductsDto) {
    const limit = query.limit ?? 20;
    const page = query.page && query.page > 0 ? query.page : 1;
    const cacheKey = `hamkor:products:list:ready:${JSON.stringify(query)}`;
    const cached = await this.redis.getJson<{
      items: unknown[];
      nextCursor: string | null;
      total: number;
      page: number;
      totalPages: number;
    }>(cacheKey);
    if (cached) return this.withStorefrontMask(cached);

    const filter: Record<string, unknown> = {
      status: ProductStatus.Active,
      isActive: true,
      ...storefrontReadyMongoFilter(),
    };

    if (query.partnerId) {
      filter.partnerId = new Types.ObjectId(query.partnerId);
    }

    if (query.categoryId) {
      filter.categoryId = new Types.ObjectId(query.categoryId);
    }

    if (query.q) {
      filter.$text = { $search: query.q };
    }

    const total = await this.productModel.countDocuments(filter).exec();
    const skip = (page - 1) * limit;

    const items = await this.productModel
      .find(filter)
      .populate('categoryId', 'name slug')
      .populate('partnerId', 'name slug image')
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const result = {
      items,
      nextCursor: null,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
    if (total > 0 && items.length > 0) {
      const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
      await this.redis.setJson(cacheKey, result, ttl);
    }
    return this.withStorefrontMask(result);
  }

  async findAllAdmin(
    page = 1,
    limit = 100,
    q?: string,
    incomplete?: boolean,
  ) {
    const safePage = page > 0 ? page : 1;
    const safeLimit = Math.min(Math.max(limit || 100, 1), 100);
    const and: Record<string, unknown>[] = [];

    const term = q?.trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      and.push({
        $or: [
          { name: { $regex: escaped, $options: 'i' } },
          { code: { $regex: escaped, $options: 'i' } },
        ],
      });
    }

    if (incomplete) {
      and.push(incompleteProductMongoFilter());
    }

    const filter: Record<string, unknown> =
      and.length > 0 ? { $and: and } : {};

    const [items, total] = await Promise.all([
      this.productModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean()
        .exec(),
      this.productModel.countDocuments(filter).exec(),
    ]);

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  async findBySlug(slug: string) {
    let decoded = slug;
    try {
      for (let i = 0; i < 2; i++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      decoded = slug;
    }

    const cacheKey = `hamkor:products:slug:ready:${decoded}`;
    let product = await this.redis.getJson<Record<string, unknown>>(cacheKey);

    if (!product) {
      const found = await this.productModel
        .findOne({
          slug: decoded,
          status: ProductStatus.Active,
          isActive: true,
          ...storefrontReadyMongoFilter(),
        })
        .populate('categoryId', 'name slug')
        .populate('partnerId', 'name slug image')
        .lean()
        .exec();

      if (!found) {
        throw new NotFoundException('Product not found');
      }

      product = found as unknown as Record<string, unknown>;
      const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
      await this.redis.setJson(cacheKey, product, ttl);
    }

    if (
      !isStorefrontReadyProduct(
        product as Parameters<typeof isStorefrontReadyProduct>[0],
      )
    ) {
      await this.redis.del(cacheKey);
      throw new NotFoundException('Product not found');
    }

    const settings = await this.productsService.getDisplaySettings();
    return maskStorefrontProduct(product, settings);
  }

  async findById(id: string) {
    const product = await this.productModel
      .findById(id)
      .populate('partnerId', 'name slug image')
      .lean()
      .exec();
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async update(id: string, dto: UpdateHamkorProductDto) {
    if (dto.partnerId) {
      await this.partnersService.findById(dto.partnerId);
    }
    if (dto.categoryId) {
      const category = await this.categoriesService.findById(dto.categoryId);
      const partnerId = dto.partnerId ?? String(category.partnerId);
      if (String(category.partnerId) !== partnerId) {
        throw new ConflictException(
          'Kategoriya tanlangan hamkorga tegishli emas',
        );
      }
    }

    const updatePayload: Record<string, unknown> = { ...dto };

    if (dto.slug) {
      updatePayload.slug = await this.buildUniqueSlug(slugify(dto.slug), id);
    }

    if (dto.code !== undefined) {
      const code = dto.code.trim().toUpperCase();
      const codeConflict = await this.productModel
        .findOne({ code, _id: { $ne: id } })
        .select('_id')
        .lean()
        .exec();
      if (codeConflict) {
        throw new ConflictException('Bu mahsulot kodi allaqachon mavjud');
      }
      updatePayload.code = code;
    }
    if (dto.partnerId) {
      updatePayload.partnerId = new Types.ObjectId(dto.partnerId);
    }
    if (dto.categoryId) {
      updatePayload.categoryId = new Types.ObjectId(dto.categoryId);
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

  private async buildUniqueSlug(base: string, excludeId?: string) {
    const root = base || `p-${Date.now().toString(36)}`;
    let candidate = root;
    let i = 2;
    for (;;) {
      const filter: Record<string, unknown> = { slug: candidate };
      if (excludeId) filter._id = { $ne: excludeId };
      const exists = await this.productModel.exists(filter);
      if (!exists) return candidate;
      candidate = `${root}-${i}`;
      i += 1;
    }
  }

  private async withStorefrontMask<T extends { items: unknown[] }>(
    result: T,
  ): Promise<T> {
    const settings = await this.productsService.getDisplaySettings();
    if (!settings.hiddenFields.length && !settings.hiddenSpecLabels.length) {
      return result;
    }
    return {
      ...result,
      items: (result.items as Record<string, unknown>[]).map((item) =>
        maskStorefrontProduct(item, settings),
      ),
    };
  }

  private async invalidateCache(productId: string, slug?: string) {
    await this.redis.delByPattern('hamkor:products:list:*');
    await this.redis.del(`hamkor:products:id:${productId}`);
    if (slug) {
      await this.redis.del(`hamkor:products:slug:${slug}`);
      await this.redis.del(`hamkor:products:slug:ready:${slug}`);
    }
    await this.redis.delByPattern('hamkor:categories:*');
  }
}
