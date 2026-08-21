import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { unlink } from 'fs/promises';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { Product } from './schemas/product.schema';
import { CategoriesService } from '../categories/categories.service';
import { RedisService } from '../redis/redis.service';
import { R2StorageService } from '../uploads/r2-storage.service';
import { slugify } from '../../common/utils/slugify';
import { ProductStatus } from '../../common/enums/product-status.enum';
import {
  extractRowImagesFromXlsx,
  preserveImageBuffer,
} from './excel-image-extractor';
import {
  PRODUCT_IMAGE_PLACEHOLDER,
  isPlaceholderProductImage,
} from './product-completeness';

export const EXCEL_IMPORT_MAX_BYTES = 150 * 1024 * 1024;
export { isPlaceholderProductImage, PRODUCT_IMAGE_PLACEHOLDER };

type ColumnKind =
  | 'code'
  | 'name'
  | 'category'
  | 'price'
  | 'wholesale'
  | 'stock'
  | 'barcode'
  | 'skip'
  | 'spec';

type ColumnDef = { kind: ColumnKind; label: string };

export type ExcelImportResult = {
  ok: number;
  failed: number;
  created: number;
  updated: number;
  deleted: number;
  createdCategories: number;
  totalRows: number;
  errors: string[];
};

type ParsedRow = {
  excelRow: number;
  code: string;
  name: string;
  categoryName: string;
  price: number;
  wholesalePrice: number;
  /** null = Excel da ombor ustuni yo‘q → stock ni o‘zgartirmaslik */
  stock: number | null;
  barcode?: string;
  specs: Array<{ label: string; value: string }>;
  imageUrl: string;
};

@Injectable()
export class ExcelImportService {
  private readonly logger = new Logger(ExcelImportService.name);

  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    private readonly categoriesService: CategoriesService,
    private readonly redis: RedisService,
    private readonly r2: R2StorageService,
  ) {}

  async importFromUpload(
    file: Express.Multer.File,
    options?: { replace?: boolean },
  ): Promise<ExcelImportResult> {
    if (!file?.path) {
      throw new BadRequestException('Excel fayl yuklanmadi');
    }

    const ext = extname(file.originalname || '').toLowerCase();
    if (ext && ext !== '.xlsx') {
      await this.safeUnlink(file.path);
      throw new BadRequestException(
        'Faqat .xlsx format qabul qilinadi. Faylni .xlsx qilib saqlang.',
      );
    }

    try {
      return await this.importFromPath(file.path, {
        replace: Boolean(options?.replace),
      });
    } finally {
      await this.safeUnlink(file.path);
    }
  }

  private async importFromPath(
    filePath: string,
    options?: { replace?: boolean },
  ): Promise<ExcelImportResult> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(filePath);
    } catch (e) {
      this.logger.warn(`Excel ochilmadi: ${String(e)}`);
      throw new BadRequestException(
        'Excel oʻqilmadi. Faylni .xlsx formatida saqlab qayta urinib koʻring.',
      );
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excelda varaq (sheet) topilmadi');
    }

    const { headerRowNumber, columns } = this.findHeader(worksheet);
    if (!headerRowNumber || !columns.length) {
      throw new BadRequestException(
        'Header topilmadi. Excelda «Код» va «Название» ustunlari boʻlishi kerak.',
      );
    }

    const parsed: ParsedRow[] = [];
    const errors: string[] = [];
    const emptyImages = new Map<number, string>();

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return;

      try {
        const item = this.parseDataRow(row, rowNumber, columns, emptyImages);
        if (item) parsed.push(item);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Qator xato';
        errors.push(`Qator ${rowNumber}: ${msg}`);
      }
    });

    if (!parsed.length) {
      throw new BadRequestException(
        'Excelda mahsulot qatorlari topilmadi. Formatni tekshiring.',
      );
    }

    // Mavjud tovarlar (case-insensitive kod) — ular uchun Excel rasmi yuklanmaydi.
    const codes = [...new Set(parsed.map((r) => r.code))];
    const existing = await this.findExistingByCodes(codes);
    const existingCodes = new Set(existing.map((p) => this.normCode(p.code)));

    const rowsNeedingImage = new Set(
      parsed
        .filter((r) => !existingCodes.has(r.code))
        .map((r) => r.excelRow),
    );

    const imagesByRow = await this.extractImages(
      filePath,
      workbook,
      worksheet,
      rowsNeedingImage,
    );
    for (const row of parsed) {
      // Mavjud tovar: imageUrl umuman qo‘yilmaydi (persist ham images ga tegmaydi).
      if (existingCodes.has(row.code)) {
        row.imageUrl = PRODUCT_IMAGE_PLACEHOLDER;
        continue;
      }
      const url = imagesByRow.get(row.excelRow);
      if (url) row.imageUrl = url;
    }

    // replace=true ham wipe qilmaydi — kod bo‘yicha upsert; eski R2 rasmlar saqlanadi.
    if (options?.replace) {
      this.logger.log(
        `Replace import: wipe yo‘q, kod bo‘yicha upsert (${parsed.length} qator)`,
      );
    }

    const result = await this.persistRows(parsed, errors);
    return { ...result, deleted: 0 };
  }

  private findHeader(worksheet: ExcelJS.Worksheet): {
    headerRowNumber: number;
    columns: ColumnDef[];
  } {
    const maxScan = Math.min(worksheet.rowCount || 30, 40);

    for (let r = 1; r <= maxScan; r++) {
      const row = worksheet.getRow(r);
      const headers: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber - 1] = this.cellStr(cell.value);
      });

      while (headers.length && !headers[headers.length - 1]) {
        headers.pop();
      }

      const normalized = headers.map((h) => this.normalizeHeader(h));
      const hasCode = normalized.some(
        (h) =>
          h === 'код' ||
          h === 'code' ||
          h === 'kod' ||
          h === 'артикул' ||
          h === 'sku',
      );
      const hasName = normalized.some(
        (h) =>
          h === 'название' ||
          h === 'наименование' ||
          h === 'name' ||
          h === 'nomi' ||
          h === 'mahsulot',
      );
      const hasPhoto = normalized.some(
        (h) => h === 'фото' || h === 'photo' || h === 'rasm' || h === 'image',
      );

      if (hasCode && (hasName || hasPhoto)) {
        return {
          headerRowNumber: r,
          columns: headers.map((h) => this.classifyHeader(h)),
        };
      }
    }

    return { headerRowNumber: 0, columns: [] };
  }

  private classifyHeader(header: string): ColumnDef {
    const h = this.normalizeHeader(header);
    if (!h) return { kind: 'skip', label: header };

    if (
      h === '№' ||
      h === 'no' ||
      h === 'nomer' ||
      h === '#' ||
      h === 'фото' ||
      h === 'photo' ||
      h === 'rasm' ||
      h === 'image' ||
      h === 'ваш заказ' ||
      h.includes('ваш заказ') ||
      h === 'номер карточки'
    ) {
      return { kind: 'skip', label: header };
    }

    if (
      h === 'код' ||
      h === 'code' ||
      h === 'kod' ||
      h === 'артикул' ||
      h === 'sku'
    ) {
      return { kind: 'code', label: header.trim() };
    }

    if (
      h === 'название' ||
      h === 'наименование' ||
      h === 'name' ||
      h === 'nomi' ||
      h === 'mahsulot'
    ) {
      return { kind: 'name', label: header.trim() };
    }

    if (
      h === 'группа' ||
      h === 'group' ||
      h === 'kategoriya' ||
      h === 'категория' ||
      h === 'category'
    ) {
      return { kind: 'category', label: header.trim() };
    }

    // J: discounted / markup USD price → wholesale
    if (
      (h.includes('прайс') || h.includes('price') || h.includes('цена')) &&
      (h.includes('скидк') || h.includes('наценк') || h.includes('discount'))
    ) {
      return { kind: 'wholesale', label: header.trim() };
    }

    // I: base Прайс USD → retail price
    if (
      h.includes('прайс') &&
      (h.includes('usd') || h.includes('тип цены') || h.includes('цена'))
    ) {
      return { kind: 'price', label: header.trim() };
    }

    if (
      h === 'цена' ||
      h === 'price' ||
      h === 'narx' ||
      h === 'oddiy narx' ||
      h.includes('цена розн')
    ) {
      return { kind: 'price', label: header.trim() };
    }

    if (
      h === 'оптом' ||
      h === 'wholesale' ||
      h === 'optom' ||
      h.includes('цена опт')
    ) {
      return { kind: 'wholesale', label: header.trim() };
    }

    // Faqat haqiqiy ombor qoldig‘i → stock
    // "Кол-во в кейсе" / box qty — stock EMAS (faqat specs)
    if (
      h === 'stock' ||
      h === 'остаток' ||
      h === 'ombor' ||
      h === 'ombordagi son' ||
      h === 'qoldiq' ||
      h === 'soni' ||
      (h === 'количество' && !h.includes('кейсе')) ||
      (h === 'кол-во' && !h.includes('кейсе')) ||
      (h === 'кол во' && !h.includes('кейсе')) ||
      h.includes('остаток') ||
      (h.includes('quantity') &&
        !h.includes('case') &&
        !h.includes('кейсе')) ||
      (h.includes('stock') && !h.includes('фото') && !h.includes('кейсе'))
    ) {
      return { kind: 'stock', label: header.trim() };
    }

    // Korobkadagi son — specs (stock emas!)
    if (
      h.includes('кол-во в кейсе') ||
      h.includes('количество в кейсе') ||
      h.includes('qty in case') ||
      h.includes('quantity in case') ||
      (h.includes('кейсе') && (h.includes('кол') || h.includes('колич')))
    ) {
      return { kind: 'spec', label: header.trim() };
    }

    // Shtrix-kod → barcode (Smartup sync)
    if (
      h === 'barcode' ||
      h === 'штрих-код' ||
      h === 'штрихкод' ||
      h === 'штрих код' ||
      h === 'shtrix' ||
      h === 'shtrix-kod' ||
      h.includes('штрих') ||
      h.includes('barcode')
    ) {
      return { kind: 'barcode', label: header.trim() };
    }

    // Packaging / manufacturer → specs
    return { kind: 'spec', label: header.trim() || h };
  }

  private parseDataRow(
    row: ExcelJS.Row,
    rowNumber: number,
    columns: ColumnDef[],
    imagesByRow: Map<number, string>,
  ): ParsedRow | null {
    let code = '';
    let name = '';
    let categoryName = '';
    let price = 0;
    let wholesalePrice = 0;
    let hasWholesale = false;
    let stock: number | null = null;
    let barcode: string | undefined;
    const specs: Array<{ label: string; value: string }> = [];

    for (let c = 0; c < columns.length; c++) {
      const col = columns[c]!;
      if (col.kind === 'skip') continue;

      const cell = row.getCell(c + 1);
      const raw = cell.value;
      const value = this.cellStr(raw);

      if (
        !value &&
        col.kind !== 'price' &&
        col.kind !== 'wholesale' &&
        col.kind !== 'stock'
      ) {
        continue;
      }

      switch (col.kind) {
        case 'code':
          // "HYT - 42" va "HYT-42" bir xil kod
          code = this.normCode(value);
          break;
        case 'name':
          name = value;
          break;
        case 'category':
          categoryName = value;
          break;
        case 'price':
          price = this.cellNum(raw, 0);
          break;
        case 'wholesale':
          wholesalePrice = this.cellNum(raw, 0);
          hasWholesale = true;
          break;
        case 'stock': {
          const n = this.cellNum(raw, NaN);
          if (Number.isFinite(n) && n >= 0) {
            stock = Math.floor(n);
          }
          // Spec sifatida ham saqlaymiz (кейсе / qoldiq ma'lumoti)
          if (value) specs.push({ label: col.label, value });
          break;
        }
        case 'barcode': {
          const bc = value.replace(/\s+/g, '').trim();
          if (bc) barcode = bc;
          break;
        }
        case 'spec':
          if (value) specs.push({ label: col.label, value });
          break;
        default:
          break;
      }
    }

    // Category / manufacturer separator rows (no product code)
    if (!code && !name) return null;
    if (!code) return null;

    if (!name) name = code;
    if (!hasWholesale) wholesalePrice = price;

    return {
      excelRow: rowNumber,
      code,
      name,
      categoryName,
      price,
      wholesalePrice,
      stock: stock != null ? stock : null,
      ...(barcode ? { barcode } : {}),
      specs,
      imageUrl: imagesByRow.get(rowNumber) || PRODUCT_IMAGE_PLACEHOLDER,
    };
  }

  /**
   * ZIP `xl/media` + drawings/cellimages orqali original bufferni oladi.
   * Kattalashtirish / qayta siqish yo‘q — sifat saqlanadi.
   */
  private async extractImages(
    filePath: string,
    workbook: ExcelJS.Workbook,
    worksheet: ExcelJS.Worksheet,
    /** Faqat shu Excel qatorlari uchun R2 ga yuklash (mavjud rasmlarni himoya). */
    onlyRows?: Set<number>,
  ): Promise<Map<number, string>> {
    const byRow = new Map<number, string>();

    let extracted: Awaited<ReturnType<typeof extractRowImagesFromXlsx>>;

    try {
      extracted = await extractRowImagesFromXlsx(filePath, {
        workbook,
        worksheet,
      });
    } catch (e) {
      this.logger.warn(`ZIP rasm extract xato: ${String(e)}`);
      return byRow;
    }

    const entries = [...extracted.entries()].filter(
      ([excelRow]) => !onlyRows || onlyRows.has(excelRow),
    );

    this.logger.log(
      `Excel rasmlar: ${extracted.size} ta topildi, R2 ga ${entries.length} ta yuklanadi (mavjud rasmlar skip)`,
    );

    const CONCURRENCY = 24;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const slice = entries.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async ([excelRow, img]) => {
          try {
            const preserved = await preserveImageBuffer(
              img.buffer,
              img.extension,
            );
            const filename = `${randomUUID()}.${preserved.ext}`;
            const contentType =
              preserved.ext === 'png'
                ? 'image/png'
                : preserved.ext === 'webp'
                  ? 'image/webp'
                  : preserved.ext === 'gif'
                    ? 'image/gif'
                    : 'image/jpeg';
            const url = await this.r2.putObject({
              key: `products/${filename}`,
              body: preserved.buffer,
              contentType,
            });
            byRow.set(excelRow, url);
          } catch (e) {
            this.logger.warn(
              `Rasm saqlanmadi (qator ${excelRow}): ${String(e)}`,
            );
          }
        }),
      );
    }

    return byRow;
  }

  /**
   * Kodni solishtirish: bo‘sh joylar olib tashlanadi.
   * "HYT - 42" === "HYT-42" === "hyt-42"
   */
  private normCode(code: unknown): string {
    return String(code ?? '')
      .trim()
      .toUpperCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, '');
  }

  /** Bo‘shliq/case farqiga qaramay mavjud tovarlarni topadi. */
  private async findExistingByCodes(codes: string[]): Promise<
    Array<{
      _id: Types.ObjectId;
      code: string;
      slug: string;
      images: string[];
    }>
  > {
    if (!codes.length) return [];
    const keys = [
      ...new Set(codes.map((c) => this.normCode(c)).filter(Boolean)),
    ];
    if (!keys.length) return [];

    type Row = {
      _id: Types.ObjectId;
      code: string;
      slug: string;
      images: string[];
    };

    // 1) Aniq moslik (tez)
    const exact = (await this.productModel
      .find({ code: { $in: keys } })
      .select('_id code slug images')
      .lean()
      .exec()) as Row[];

    // 2) Bo‘shliq farqi: "HYT - 42" ↔ "HYT-42"
    const fromAgg = await this.productModel.aggregate<Row>([
      {
        $addFields: {
          codeKey: {
            $toUpper: {
              $reduce: {
                input: {
                  $split: [{ $ifNull: ['$code', ''] }, ' '],
                },
                initialValue: '',
                in: { $concat: ['$$value', '$$this'] },
              },
            },
          },
        },
      },
      { $match: { codeKey: { $in: keys } } },
      { $project: { _id: 1, code: 1, slug: 1, images: 1 } },
    ]);

    const byId = new Map<string, Row>();
    for (const p of [...exact, ...fromAgg]) {
      byId.set(String(p._id), p);
    }
    return [...byId.values()];
  }

  /**
   * Bir xil normCode bo‘yicha dublikatlar: rasmi borini saqlab,
   * rasmsiz / placeholder nusxalarni o‘chiradi (eski bugdan qolganlar).
   */
  private async dedupeOrphanProducts(codes: string[]): Promise<number> {
    const existing = await this.findExistingByCodes(codes);
    const groups = new Map<string, typeof existing>();
    for (const p of existing) {
      const key = this.normCode(p.code);
      const list = groups.get(key) ?? [];
      list.push(p);
      groups.set(key, list);
    }

    const toDelete: Types.ObjectId[] = [];
    for (const [, list] of groups) {
      if (list.length < 2) continue;
      const withReal = list.filter((p) =>
        (p.images ?? []).some((u) => !isPlaceholderProductImage(u)),
      );
      const withoutReal = list.filter(
        (p) =>
          !(p.images ?? []).some((u) => !isPlaceholderProductImage(u)),
      );
      if (!withReal.length || !withoutReal.length) continue;
      // Rasmi bor kamida 1 ta — rasmsiz dublikatlarni o‘chiramiz
      for (const p of withoutReal) toDelete.push(p._id);
    }

    if (!toDelete.length) return 0;
    const res = await this.productModel
      .deleteMany({ _id: { $in: toDelete } })
      .exec();
    this.logger.warn(
      `Dublikat rasmsiz tovarlar o‘chirildi: ${res.deletedCount ?? 0}`,
    );
    return res.deletedCount ?? 0;
  }

  private async persistRows(
    rows: ParsedRow[],
    seedErrors: string[],
  ): Promise<ExcelImportResult> {
    const errors = [...seedErrors];
    let createdCategories = 0;

    const categories = (await this.categoriesService.findAll(false)) as Array<{
      _id: Types.ObjectId | string;
      name: string;
    }>;
    const catCache = new Map<string, string>();
    for (const c of categories) {
      catCache.set(this.normName(c.name), String(c._id));
    }

    const ensureCategory = async (name: string): Promise<string> => {
      const key = this.normName(name);
      const hit = catCache.get(key);
      if (hit) return hit;

      try {
        const created = await this.categoriesService.create({
          name: name.trim(),
          isActive: true,
        });
        const id = String(
          (created as { _id: Types.ObjectId | string })._id,
        );
        catCache.set(key, id);
        createdCategories += 1;
        return id;
      } catch {
        const refreshed = (await this.categoriesService.findAll(
          false,
        )) as Array<{ _id: Types.ObjectId | string; name: string }>;
        for (const c of refreshed) {
          catCache.set(this.normName(c.name), String(c._id));
        }
        const again = catCache.get(key);
        if (again) return again;
        throw new Error(`Kategoriya yaratilmadi: ${name}`);
      }
    };

    const fallbackId = await ensureCategory('Boshqa');

    const existingByCode = new Map<
      string,
      { id: string; slug: string; hasRealImage: boolean }
    >();
    const codes = [...new Set(rows.map((r) => r.code))];
    const existing = await this.findExistingByCodes(codes);
    for (const p of existing) {
      const key = this.normCode(p.code);
      const imgs = Array.isArray(p.images) ? p.images : [];
      const hasRealImage = imgs.some((u) => !isPlaceholderProductImage(u));
      const prev = existingByCode.get(key);
      // Bir xil kodning bir nechta varianti bo‘lsa — rasmi borini tanlaymiz
      if (!prev || (hasRealImage && !prev.hasRealImage)) {
        existingByCode.set(key, {
          id: String(p._id),
          slug: p.slug as string,
          hasRealImage,
        });
      }
    }

    const usedSlugs = new Set<string>();
    const slugs = await this.productModel.find({}).select('slug').lean().exec();
    for (const p of slugs) usedSlugs.add(String(p.slug));

    const allocSlug = (code: string, name: string): string => {
      const root =
        slugify(code) || slugify(name) || `p-${Date.now().toString(36)}`;
      let candidate = root;
      let i = 2;
      while (usedSlugs.has(candidate)) {
        candidate = `${root}-${i}`;
        i += 1;
      }
      usedSlugs.add(candidate);
      return candidate;
    };

    const docsByCode = new Map<string, Record<string, unknown>>();
    const updateOps: Parameters<typeof this.productModel.bulkWrite>[0] = [];
    let updated = 0;
    let failed = 0;
    const touchedIds: string[] = [];
    const touchedSlugs: string[] = [];

    for (const row of rows) {
      try {
        let categoryId = fallbackId;
        if (row.categoryName.trim()) {
          categoryId = await ensureCategory(row.categoryName);
        }

        const prev = existingByCode.get(row.code);
        if (prev) {
          // images va code UMUMAN yozilmaydi — rasm + eski kod saqlanadi.
          updateOps.push({
            updateOne: {
              filter: { _id: new Types.ObjectId(prev.id) },
              update: {
                $set: {
                  name: row.name,
                  description: row.name,
                  price: row.price,
                  wholesalePrice: row.wholesalePrice,
                  ...(row.stock != null ? { stock: row.stock } : {}),
                  ...(row.barcode ? { barcode: row.barcode } : {}),
                  categoryId: new Types.ObjectId(categoryId),
                  specs: row.specs,
                  status: ProductStatus.Active,
                  isActive: true,
                },
              },
            },
          });
          updated += 1;
          touchedIds.push(prev.id);
          touchedSlugs.push(prev.slug);
        } else {
          const existingDoc = docsByCode.get(row.code);
          const id = existingDoc
            ? (existingDoc._id as Types.ObjectId)
            : new Types.ObjectId();
          const slug = existingDoc
            ? String(existingDoc.slug)
            : allocSlug(row.code, row.name);
          docsByCode.set(row.code, {
            _id: id,
            name: row.name,
            code: row.code,
            slug,
            description: row.name,
            price: row.price,
            wholesalePrice: row.wholesalePrice,
            stock: row.stock != null ? row.stock : 0,
            ...(row.barcode ? { barcode: row.barcode } : {}),
            categoryId: new Types.ObjectId(categoryId),
            images: [row.imageUrl],
            specs: row.specs,
            status: ProductStatus.Active,
            isActive: true,
            tags: [],
          });
          existingByCode.set(row.code, {
            id: String(id),
            slug,
            hasRealImage: !isPlaceholderProductImage(row.imageUrl),
          });
          if (!existingDoc) {
            touchedIds.push(String(id));
            touchedSlugs.push(slug);
          }
        }
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : 'Xato';
        errors.push(`Qator ${row.excelRow} (${row.code}): ${msg}`);
      }
    }

    // Insert oldidan yana bir marta tekshiruv — dublikat/rasm yo‘qolishini oldini oladi
    if (docsByCode.size) {
      const pendingCodes = [...docsByCode.keys()];
      const again = await this.findExistingByCodes(pendingCodes);
      for (const p of again) {
        const key = this.normCode(p.code);
        const pending = docsByCode.get(key);
        if (!pending) continue;
        docsByCode.delete(key);
        const imgs = Array.isArray(p.images) ? p.images : [];
        const hasRealImage = imgs.some(
          (u) => !isPlaceholderProductImage(u),
        );
        existingByCode.set(key, {
          id: String(p._id),
          slug: p.slug,
          hasRealImage,
        });
        const rowLike = rows.find((r) => r.code === key);
        if (!rowLike) continue;
        let categoryId = fallbackId;
        if (rowLike.categoryName.trim()) {
          categoryId = await ensureCategory(rowLike.categoryName);
        }
        updateOps.push({
          updateOne: {
            filter: { _id: p._id },
            update: {
              $set: {
                name: rowLike.name,
                description: rowLike.name,
                price: rowLike.price,
                wholesalePrice: rowLike.wholesalePrice,
                ...(rowLike.stock != null ? { stock: rowLike.stock } : {}),
                ...(rowLike.barcode ? { barcode: rowLike.barcode } : {}),
                categoryId: new Types.ObjectId(categoryId),
                specs: rowLike.specs,
                status: ProductStatus.Active,
                isActive: true,
              },
            },
          },
        });
        updated += 1;
        touchedIds.push(String(p._id));
        touchedSlugs.push(p.slug);
      }
    }

    const docs = [...docsByCode.values()];
    let created = 0;

    const CHUNK = 300;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK);
      try {
        await this.productModel.insertMany(chunk, { ordered: false });
        created += chunk.length;
      } catch (e) {
        // Unique code conflict → update (images tegilmaydi)
        const err = e as {
          message?: string;
          writeErrors?: Array<{ err?: { op?: Record<string, unknown> } }>;
          insertedDocs?: unknown[];
        };
        const inserted = Array.isArray(err.insertedDocs)
          ? err.insertedDocs.length
          : 0;
        created += inserted;
        this.logger.warn(`insertMany qisman: ${err.message || String(e)}`);

        for (const doc of chunk) {
          const code = this.normCode(doc.code);
          const found = await this.findExistingByCodes([code]);
          const keep =
            found.find((p) =>
              (p.images ?? []).some((u) => !isPlaceholderProductImage(u)),
            ) ?? found[0];
          if (!keep) continue;
          await this.productModel
            .updateOne(
              { _id: keep._id },
              {
                $set: {
                  name: doc.name,
                  description: doc.description,
                  price: doc.price,
                  wholesalePrice: doc.wholesalePrice,
                  ...(doc.stock != null ? { stock: doc.stock } : {}),
                  ...(doc.barcode ? { barcode: doc.barcode } : {}),
                  categoryId: doc.categoryId,
                  specs: doc.specs,
                  status: doc.status,
                  isActive: doc.isActive,
                },
              },
            )
            .exec();
          updated += 1;
          touchedIds.push(String(keep._id));
          touchedSlugs.push(keep.slug);
        }
      }
    }

    for (let i = 0; i < updateOps.length; i += CHUNK) {
      const chunk = updateOps.slice(i, i + CHUNK);
      try {
        await this.productModel.bulkWrite(chunk, { ordered: false });
      } catch (e) {
        this.logger.error(`bulkWrite xato: ${String(e)}`);
        const writeErr = e as { message?: string };
        errors.push(
          `Yangilashda xato (qism): ${writeErr.message || 'bulkWrite failed'}`,
        );
      }
    }

    // Eski bugdan qolgan rasmsiz dublikatlarni tozalash
    await this.dedupeOrphanProducts(codes);

    await this.invalidateCaches(touchedIds, touchedSlugs);

    const ok = created + updated;
    return {
      ok,
      failed,
      created,
      updated,
      deleted: 0,
      createdCategories,
      totalRows: rows.length,
      errors: errors.slice(0, 80),
    };
  }

  private async invalidateCaches(ids: string[], slugs: string[]) {
    await this.redis.delByPattern('products:list:*');
    await this.redis.delByPattern('seo:*');
    await this.redis.delByPattern('categories:list*');
    for (const id of ids) {
      await this.redis.del(`products:id:${id}`);
    }
    for (const slug of slugs) {
      await this.redis.del(`products:slug:${slug}`);
    }
  }

  private cellStr(value: unknown): string {
    if (value == null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'object') {
      const v = value as {
        text?: string;
        result?: unknown;
        richText?: Array<{ text?: string }>;
        hyperlink?: string;
      };
      if (typeof v.text === 'string') return v.text.trim();
      if (Array.isArray(v.richText)) {
        return v.richText
          .map((t) => t.text || '')
          .join('')
          .trim();
      }
      if (v.result != null) return this.cellStr(v.result);
    }
    return String(value).trim();
  }

  private cellNum(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'object' && value != null) {
      const v = value as { result?: unknown };
      if (v.result != null) return this.cellNum(v.result, fallback);
    }
    const s = this.cellStr(value).replace(/\s/g, '').replace(',', '.');
    if (!s) return fallback;
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
  }

  private normalizeHeader(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/\(\*\)/g, '')
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normName(s: string) {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private async safeUnlink(path: string) {
    try {
      await unlink(path);
    } catch {
      /* ignore */
    }
  }
}
