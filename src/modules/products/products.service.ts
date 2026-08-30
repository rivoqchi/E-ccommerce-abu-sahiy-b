import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Product } from './schemas/product.schema';
import {
  ProductDisplaySettings,
  PRODUCT_DISPLAY_SETTINGS_KEY,
} from './schemas/product-display-settings.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { slugify } from '../../common/utils/slugify';
import { newHighlightUntilFromNow } from '../../common/utils/product-new-highlight';
import {
  normalizePiecesPerBox,
  stockAdjustTotalDelta,
} from '../../common/utils/product-units';
import { RedisService } from '../redis/redis.service';
import { ProductStatus } from '../../common/enums/product-status.enum';
import { CategoriesService } from '../categories/categories.service';
import { BrandsService } from '../brands/brands.service';
import { Order } from '../orders/schemas/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import {
  incompleteProductMongoFilter,
  isStorefrontReadyProduct,
  storefrontReadyMongoFilter,
  firstProductImage,
} from './product-completeness';
import {
  maskStorefrontProduct,
  normalizeSpecLabel,
  sanitizeHiddenFields,
  sanitizeHiddenSpecLabels,
  type ProductDisplayField,
} from './product-display-fields';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    @InjectModel(ProductDisplaySettings.name)
    private readonly displaySettingsModel: Model<ProductDisplaySettings>,
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

    const code = dto.code.trim().toUpperCase();
    const codeExists = await this.productModel.exists({ code });
    if (codeExists) {
      throw new ConflictException('Bu mahsulot kodi allaqachon mavjud');
    }

    // URL uchun kod asosida slug (kirill nomlardan qochamiz)
    const slug = await this.buildUniqueSlug(
      dto.slug ? slugify(dto.slug) : slugify(code) || slugify(dto.name),
    );

    const barcode = dto.barcode?.replace(/\s+/g, '').trim() || undefined;
    const { highlightAsNew, ...productFields } = dto;

    const product = await this.productModel.create({
      ...productFields,
      code,
      barcode,
      description: dto.description?.trim() || dto.name,
      slug,
      price: dto.price,
      wholesalePrice:
        dto.wholesalePrice !== undefined ? dto.wholesalePrice : dto.price,
      categoryId: new Types.ObjectId(dto.categoryId),
      brandId: dto.brandId ? new Types.ObjectId(dto.brandId) : undefined,
      specs: dto.specs ?? [],
      images: dto.images ?? [],
      status: dto.status ?? ProductStatus.Active,
      isActive: true,
      ...(highlightAsNew
        ? { newHighlightUntil: newHighlightUntilFromNow() }
        : {}),
    });

    await this.invalidateCache(product._id.toString(), slug);
    return product.toObject();
  }

  async findAll(query: QueryProductsDto) {
    const limit = query.limit ?? 20;
    const page = query.page && query.page > 0 ? query.page : 1;
    const useOffset = Boolean(query.page) && !query.cursor;
    const cacheKey = `products:list:ready:${JSON.stringify(query)}`;
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

    if (query.categoryId) {
      filter.categoryId = new Types.ObjectId(query.categoryId);
    }

    if (query.brandId) {
      filter.brandId = new Types.ObjectId(query.brandId);
    }

    if (query.q) {
      filter.$text = { $search: query.q };
    }

    if (query.newOnly) {
      filter.newHighlightUntil = { $gt: new Date() };
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
      .sort(
        query.newOnly
          ? { newHighlightUntil: -1, createdAt: -1, _id: -1 }
          : { createdAt: -1, _id: -1 },
      )
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
    // Bo'sh ro'yxatni cache qilmaslik — wipe/import oralig'ida sticky empty bo'lmasin
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

    const totalPages = Math.max(1, Math.ceil(total / safeLimit));
    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
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

    const cacheKey = `products:slug:ready:${decoded}`;
    let product = await this.redis.getJson<Record<string, unknown>>(cacheKey);

    if (!product) {
      let found = await this.productModel
        .findOne({
          slug: decoded,
          status: ProductStatus.Active,
          isActive: true,
          ...storefrontReadyMongoFilter(),
        })
        .populate('categoryId', 'name slug')
        .populate('brandId', 'name slug')
        .lean()
        .exec();

      if (!found && Types.ObjectId.isValid(decoded)) {
        found = await this.productModel
          .findOne({
            _id: new Types.ObjectId(decoded),
            status: ProductStatus.Active,
            isActive: true,
            ...storefrontReadyMongoFilter(),
          })
          .populate('categoryId', 'name slug')
          .populate('brandId', 'name slug')
          .lean()
          .exec();
      }

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

    const productId = String(
      (product as { _id?: Types.ObjectId | string })._id ?? '',
    );
    const purchaseStats = await this.getBuyerStats(productId);
    const settings = await this.getDisplaySettings();

    return maskStorefrontProduct(
      {
        ...product,
        buyerCount: purchaseStats.buyerCount,
        recentBuyers: purchaseStats.recentBuyers,
      },
      settings,
    );
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

  async mapFirstImages(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id) => Types.ObjectId.isValid(id)))];
    const map = new Map<string, string>();
    if (!unique.length) return map;
    const docs = await this.productModel
      .find({ _id: { $in: unique } })
      .select('images')
      .lean()
      .exec();
    for (const doc of docs) {
      const url = firstProductImage(doc.images);
      if (url) map.set(String(doc._id), url);
    }
    return map;
  }

  async update(id: string, dto: UpdateProductDto) {
    if (dto.categoryId) {
      await this.categoriesService.findById(dto.categoryId);
    }
    if (dto.brandId) {
      await this.brandsService.findById(dto.brandId);
    }

    const updatePayload: Record<string, unknown> = { ...dto };
    delete updatePayload.highlightAsNew;
    delete updatePayload.stockAdjust;

    if (dto.highlightAsNew === true) {
      updatePayload.newHighlightUntil = newHighlightUntilFromNow();
    } else if (dto.highlightAsNew === false) {
      updatePayload.newHighlightUntil = null;
    }

    if (dto.slug) {
      updatePayload.slug = await this.buildUniqueSlug(slugify(dto.slug), id);
    }
    // Nom o'zgarsa ham slugni buzib yubormaymiz (Excel upsert uchun muhim)

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
    if (dto.barcode !== undefined) {
      const barcode = dto.barcode.replace(/\s+/g, '').trim();
      updatePayload.barcode = barcode || undefined;
    }
    if (dto.categoryId) {
      updatePayload.categoryId = new Types.ObjectId(dto.categoryId);
    }
    if (dto.brandId) {
      updatePayload.brandId = new Types.ObjectId(dto.brandId);
    }

    const mongoUpdate: Record<string, unknown> = { $set: updatePayload };

    if (dto.piecesPerBox !== undefined) {
      const normalized = normalizePiecesPerBox(dto.piecesPerBox);
      if (normalized) {
        updatePayload.piecesPerBox = normalized;
      } else {
        delete updatePayload.piecesPerBox;
        mongoUpdate.$unset = { piecesPerBox: '' };
      }
    }

    if (dto.stockAdjust) {
      delete updatePayload.stock;
      const existing = await this.productModel.findById(id).lean().exec();
      if (!existing) {
        throw new NotFoundException('Product not found');
      }
      const ppb =
        normalizePiecesPerBox(dto.piecesPerBox) ??
        normalizePiecesPerBox(existing.piecesPerBox);
      try {
        const delta = stockAdjustTotalDelta(dto.stockAdjust, ppb);
        if (delta !== 0) mongoUpdate.$inc = { stock: delta };
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error
            ? err.message
            : 'Omborga qo‘shishda xato. Karobka uchun avval «Karobkada nechta dona» kiriting.',
        );
      }
    }

    const product = await this.productModel
      .findByIdAndUpdate(id, mongoUpdate, { new: true })
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
      .findByIdAndUpdate(
        productId,
        { $inc: { stock: delta } },
        { new: true },
      )
      .lean()
      .exec();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    await this.invalidateCache(productId, product.slug);
    return product;
  }

  /**
   * Faqat ombor sonini yozadi — boshqa product maydonlariga tegilmaydi.
   */
  async setStockOnly(productId: string, stock: number) {
    const qty = Math.max(0, Math.floor(Number(stock) || 0));
    const product = await this.productModel
      .findByIdAndUpdate(
        productId,
        { $set: { stock: qty } },
        { new: true },
      )
      .lean()
      .exec();

    if (!product) {
      throw new NotFoundException('Product not found');
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

  /**
   * Smartup sync: faol mahsulotlar (code yoki barcode orqali moslash).
   */
  async findForStockSync() {
    return this.productModel
      .find({ isActive: true })
      .select('_id barcode stock specs code')
      .lean()
      .exec();
  }

  /**
   * @deprecated use findForStockSync
   */
  async findForBarcodeStockSync() {
    return this.findForStockSync();
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

  async getDisplaySettings(): Promise<{
    hiddenFields: ProductDisplayField[];
    hiddenSpecLabels: string[];
  }> {
    const cacheKey = 'products:display-settings';
    const cached = await this.redis.getJson<{
      hiddenFields?: unknown;
      hiddenSpecLabels?: unknown;
    }>(cacheKey);
    if (cached) {
      return {
        hiddenFields: sanitizeHiddenFields(cached.hiddenFields),
        hiddenSpecLabels: sanitizeHiddenSpecLabels(cached.hiddenSpecLabels),
      };
    }

    const doc = await this.displaySettingsModel
      .findOne({ key: PRODUCT_DISPLAY_SETTINGS_KEY })
      .lean()
      .exec();
    const result = {
      hiddenFields: sanitizeHiddenFields(doc?.hiddenFields),
      hiddenSpecLabels: sanitizeHiddenSpecLabels(doc?.hiddenSpecLabels),
    };
    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, result, ttl);
    return result;
  }

  async getAdminDisplaySettings() {
    const settings = await this.getDisplaySettings();
    const specLabels = await this.listUniqueSpecLabels();
    return { ...settings, specLabels };
  }

  async updateDisplaySettings(
    hiddenFields: ProductDisplayField[],
    hiddenSpecLabels: string[],
  ) {
    const fields = sanitizeHiddenFields(hiddenFields);
    const labels = sanitizeHiddenSpecLabels(hiddenSpecLabels);
    const doc = await this.displaySettingsModel
      .findOneAndUpdate(
        { key: PRODUCT_DISPLAY_SETTINGS_KEY },
        { $set: { hiddenFields: fields, hiddenSpecLabels: labels } },
        { upsert: true, new: true },
      )
      .lean()
      .exec();

    await this.redis.del('products:display-settings');
    return {
      hiddenFields: sanitizeHiddenFields(doc?.hiddenFields ?? fields),
      hiddenSpecLabels: sanitizeHiddenSpecLabels(
        doc?.hiddenSpecLabels ?? labels,
      ),
    };
  }

  private async listUniqueSpecLabels(): Promise<string[]> {
    const rows = await this.productModel
      .aggregate<{ _id: string }>([
        { $unwind: '$specs' },
        {
          $project: {
            label: {
              $trim: { input: { $ifNull: ['$specs.label', ''] } },
            },
          },
        },
        { $match: { label: { $nin: [null, ''] } } },
        { $group: { _id: '$label' } },
        { $sort: { _id: 1 } },
        { $limit: 300 },
      ])
      .exec();
    return rows
      .map((row) => normalizeSpecLabel(String(row._id ?? '')))
      .filter(Boolean);
  }

  private async withStorefrontMask<T extends { items: unknown[] }>(
    result: T,
  ): Promise<T> {
    const settings = await this.getDisplaySettings();
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
    await this.redis.delByPattern('products:list:*');
    await this.redis.del(`products:id:${productId}`);
    if (slug) {
      await this.redis.del(`products:slug:${slug}`);
      await this.redis.del(`products:slug:ready:${slug}`);
    }
    await this.redis.delByPattern('seo:*');
    await this.redis.delByPattern('categories:list*');
  }
}
