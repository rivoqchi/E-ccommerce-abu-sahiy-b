import { mkdir, unlink, copyFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import ExcelJS from 'exceljs';
import { ExcelImportService } from './excel-import.service';

/** Minimal 1x1 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('ExcelImportService price-list format', () => {
  const tmpFiles: string[] = [];

  afterAll(async () => {
    for (const f of tmpFiles) {
      try {
        await unlink(f);
      } catch {
        /* ignore */
      }
    }
  });

  async function buildSampleWorkbook(): Promise<string> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Прайс');

    ws.getCell('A2').value = "Sultonov Oqilxo'ja";
    ws.getCell('A3').value = 'Прайс-лист';
    ws.getCell('A4').value = '06.05.2024';

    const headers = [
      '№',
      'Фото',
      'Код',
      'Штрих-код',
      'Название',
      'Кол-во в кейсе',
      'Номер карточки',
      'Ваш заказ',
      'Тип цены 1. Прайс USD',
      '1. Прайс USD со скидкой/наценкой',
      'Группа',
      'Производитель',
    ];
    headers.forEach((h, i) => {
      ws.getCell(5, i + 1).value = h;
    });

    ws.getCell('E6').value = '003. JESSIKA KERAMIKA';

    ws.getCell('A7').value = 1;
    ws.getCell('C7').value = 'JEC7337-L1';
    ws.getCell('D7').value = '9811537731971';
    ws.getCell('E7').value = 'САЛАТНИЦА JEC7337-L1 (QORA) 1Кор 6шт';
    ws.getCell('F7').value = 6;
    ws.getCell('I7').value = 12.5;
    ws.getCell('J7').value = 12.5;
    ws.getCell(7, 11).value = 'ТУЗДОН / САЛАТНИЦА';
    ws.getCell(7, 12).value = '003. JESSIKA KERAMIKA KHP';

    const imgId = wb.addImage({
      buffer: Buffer.from(PNG_1X1) as unknown as ExcelJS.Buffer,
      extension: 'png',
    });
    ws.addImage(imgId, {
      tl: { col: 1, row: 6 },
      ext: { width: 40, height: 40 },
    });

    const dir = join(process.cwd(), 'uploads', 'tmp');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `test-pricelist-${randomUUID()}.xlsx`);
    await wb.xlsx.writeFile(path);
    tmpFiles.push(path);
    return path;
  }

  function mockProductModel(opts?: {
    existing?: Array<{
      _id: Types.ObjectId;
      code: string;
      slug: string;
      images: string[];
    }>;
    bulkOps?: unknown[];
  }) {
    const existing = opts?.existing ?? [];
    const bulkOps = opts?.bulkOps ?? [];

    return {
      bulkOps,
      model: {
        aggregate: jest.fn(async () => existing),
        find: jest.fn((query?: { code?: { $in: string[] } }) => ({
          select: (fields?: string) => ({
            lean: () => ({
              exec: async () => {
                if (query?.code?.$in) {
                  return existing.filter((e) =>
                    query.code!.$in!.includes(
                      String(e.code).replace(/\s+/g, '').toUpperCase(),
                    ) ||
                    query.code!.$in!.includes(String(e.code).toUpperCase()),
                  );
                }
                if (fields === 'slug') {
                  return existing.map((e) => ({ slug: e.slug }));
                }
                return existing;
              },
            }),
          }),
        })),
        insertMany: jest.fn(async (docs: unknown[]) => {
          bulkOps.push(
            ...docs.map((document) => ({ insertOne: { document } })),
          );
          return docs;
        }),
        bulkWrite: jest.fn(async (ops: unknown[]) => {
          bulkOps.push(...ops);
          return { ok: 1 };
        }),
        deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
        updateOne: jest.fn(async () => ({ acknowledged: true })),
      },
    };
  }

  it('parses header on row 5, prices, specs, and extracts image', async () => {
    const filePath = await buildSampleWorkbook();
    const createdCats: string[] = [];
    const { model: productModel, bulkOps } = mockProductModel();

    const categoriesService = {
      findAll: jest.fn(async () => []),
      create: jest.fn(async (dto: { name: string }) => {
        createdCats.push(dto.name);
        return { _id: new Types.ObjectId(), name: dto.name };
      }),
    };

    const redis = {
      delByPattern: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
    };

    const r2 = {
      putObject: jest.fn(
        async (input: { key: string }) =>
          `https://pub-test.r2.dev/${input.key}`,
      ),
    };

    const service = new ExcelImportService(
      productModel as never,
      categoriesService as never,
      redis as never,
      r2 as never,
    );

    const copyPath = join(
      process.cwd(),
      'uploads',
      'tmp',
      `upload-${randomUUID()}.xlsx`,
    );
    await copyFile(filePath, copyPath);
    tmpFiles.push(copyPath);

    const result = await service.importFromUpload({
      path: copyPath,
      originalname: 'pricelist.xlsx',
    } as Express.Multer.File);

    expect(result.ok).toBe(1);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);
    expect(createdCats).toEqual(
      expect.arrayContaining(['Boshqa', 'ТУЗДОН / САЛАТНИЦА']),
    );
    expect(bulkOps.length).toBe(1);

    const doc = (
      bulkOps[0] as { insertOne: { document: Record<string, unknown> } }
    ).insertOne.document;
    expect(doc.code).toBe('JEC7337-L1');
    expect(doc.price).toBe(12.5);
    expect(doc.wholesalePrice).toBe(12.5);
    expect(doc.stock).toBe(6);
    expect(Array.isArray(doc.images)).toBe(true);
    expect(String((doc.images as string[])[0])).toContain(
      'https://pub-test.r2.dev/products/',
    );
  });

  it('preserves existing R2 image when Excel row has no photo (upsert)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Прайс');
    const headers = [
      '№',
      'Фото',
      'Код',
      'Штрих-код',
      'Название',
      'Кол-во в кейсе',
      'Номер карточки',
      'Ваш заказ',
      'Тип цены 1. Прайс USD',
      '1. Прайс USD со скидкой/наценкой',
      'Группа',
      'Производитель',
    ];
    headers.forEach((h, i) => {
      ws.getCell(5, i + 1).value = h;
    });
    ws.getCell('C7').value = 'JEC7337-L1';
    ws.getCell('E7').value = 'САЛАТНИЦА UPDATED';
    ws.getCell('F7').value = 10;
    ws.getCell('I7').value = 20;
    ws.getCell('J7').value = 18;
    ws.getCell(7, 11).value = 'ТУЗДОН / САЛАТНИЦА';
    ws.getCell(7, 12).value = '003. JESSIKA';

    const dir = join(process.cwd(), 'uploads', 'tmp');
    await mkdir(dir, { recursive: true });
    const noImgPath = join(dir, `test-noimg-${randomUUID()}.xlsx`);
    await wb.xlsx.writeFile(noImgPath);
    tmpFiles.push(noImgPath);

    const existingId = new Types.ObjectId();
    const oldImage = 'https://pub-test.r2.dev/products/old-keep.png';
    const bulkOps: unknown[] = [];
    const { model: productModel } = mockProductModel({
      existing: [
        {
          _id: existingId,
          code: 'jec7337-l1',
          slug: 'jec7337-l1',
          images: [oldImage],
        },
      ],
      bulkOps,
    });

    const categoriesService = {
      findAll: jest.fn(async () => [
        { _id: new Types.ObjectId(), name: 'Boshqa' },
        { _id: new Types.ObjectId(), name: 'ТУЗДОН / САЛАТНИЦА' },
      ]),
      create: jest.fn(),
    };

    const redis = {
      delByPattern: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
    };

    const r2 = {
      putObject: jest.fn(
        async (input: { key: string }) =>
          `https://pub-test.r2.dev/${input.key}`,
      ),
    };

    const service = new ExcelImportService(
      productModel as never,
      categoriesService as never,
      redis as never,
      r2 as never,
    );

    const copyPath = join(dir, `upload-noimg-${randomUUID()}.xlsx`);
    await copyFile(noImgPath, copyPath);
    tmpFiles.push(copyPath);

    const result = await service.importFromUpload(
      {
        path: copyPath,
        originalname: 'update.xlsx',
      } as Express.Multer.File,
      { replace: true },
    );

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(result.deleted).toBe(0);
    expect(bulkOps.length).toBe(1);

    const op = bulkOps[0] as {
      updateOne: { update: { $set: Record<string, unknown> } };
    };
    const $set = op.updateOne.update.$set;
    expect($set.name).toBe('САЛАТНИЦА UPDATED');
    expect($set.price).toBe(20);
    expect($set.wholesalePrice).toBe(18);
    expect($set.stock).toBe(10);
    expect($set.images).toBeUndefined();
    expect(r2.putObject).not.toHaveBeenCalled();
  });

  it('matches code ignoring spaces (HYT - 42 === HYT-42) and keeps image', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Прайс');
    [
      '№',
      'Фото',
      'Код',
      'Штрих-код',
      'Название',
      'Кол-во в кейсе',
      'Номер карточки',
      'Ваш заказ',
      'Тип цены 1. Прайс USD',
      '1. Прайс USD со скидкой/наценкой',
      'Группа',
      'Производитель',
    ].forEach((h, i) => {
      ws.getCell(5, i + 1).value = h;
    });
    ws.getCell('C7').value = 'HYT - 42';
    ws.getCell('E7').value = 'ЧАЙНЫЙ СЕРВИС';
    ws.getCell('F7').value = 6;
    ws.getCell('I7').value = 25;
    ws.getCell('J7').value = 25;
    ws.getCell(7, 11).value = 'КЕРАМИКА';

    const dir = join(process.cwd(), 'uploads', 'tmp');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `test-hyt-${randomUUID()}.xlsx`);
    await wb.xlsx.writeFile(path);
    tmpFiles.push(path);

    const existingId = new Types.ObjectId();
    const oldImage = 'https://pub-test.r2.dev/products/hyt-keep.png';
    const bulkOps: unknown[] = [];
    const { model: productModel } = mockProductModel({
      existing: [
        {
          _id: existingId,
          code: 'HYT-42',
          slug: 'hyt-42',
          images: [oldImage],
        },
      ],
      bulkOps,
    });

    const service = new ExcelImportService(
      productModel as never,
      {
        findAll: jest.fn(async () => [
          { _id: new Types.ObjectId(), name: 'Boshqa' },
          { _id: new Types.ObjectId(), name: 'КЕРАМИКА' },
        ]),
        create: jest.fn(),
      } as never,
      {
        delByPattern: jest.fn(async () => undefined),
        del: jest.fn(async () => undefined),
      } as never,
      {
        putObject: jest.fn(async (input: { key: string }) =>
          `https://pub-test.r2.dev/${input.key}`,
        ),
      } as never,
    );

    const copyPath = join(dir, `upload-hyt-${randomUUID()}.xlsx`);
    await copyFile(path, copyPath);
    tmpFiles.push(copyPath);

    const result = await service.importFromUpload({
      path: copyPath,
      originalname: 'hyt.xlsx',
    } as Express.Multer.File);

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    const op = bulkOps[0] as {
      updateOne: {
        filter: { _id: Types.ObjectId };
        update: { $set: Record<string, unknown> };
      };
    };
    expect(String(op.updateOne.filter._id)).toBe(String(existingId));
    expect(op.updateOne.update.$set.images).toBeUndefined();
    expect(op.updateOne.update.$set.code).toBeUndefined();
    expect(op.updateOne.update.$set.stock).toBe(6);
  });

  it('never overwrites existing real R2 image even when Excel has a photo', async () => {
    const filePath = await buildSampleWorkbook();
    const existingId = new Types.ObjectId();
    const oldImage = 'https://pub-test.r2.dev/products/keep-forever.png';
    const bulkOps: unknown[] = [];
    const { model: productModel } = mockProductModel({
      existing: [
        {
          _id: existingId,
          code: 'JEC7337-L1',
          slug: 'jec7337-l1',
          images: [oldImage],
        },
      ],
      bulkOps,
    });

    const categoriesService = {
      findAll: jest.fn(async () => [
        { _id: new Types.ObjectId(), name: 'Boshqa' },
        { _id: new Types.ObjectId(), name: 'ТУЗДОН / САЛАТНИЦА' },
      ]),
      create: jest.fn(),
    };

    const redis = {
      delByPattern: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
    };

    const r2 = {
      putObject: jest.fn(
        async (input: { key: string }) =>
          `https://pub-test.r2.dev/${input.key}`,
      ),
    };

    const service = new ExcelImportService(
      productModel as never,
      categoriesService as never,
      redis as never,
      r2 as never,
    );

    const copyPath = join(
      process.cwd(),
      'uploads',
      'tmp',
      `upload-keepimg-${randomUUID()}.xlsx`,
    );
    await copyFile(filePath, copyPath);
    tmpFiles.push(copyPath);

    const result = await service.importFromUpload(
      {
        path: copyPath,
        originalname: 'with-photo.xlsx',
      } as Express.Multer.File,
      { replace: true },
    );

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    const op = bulkOps[0] as {
      updateOne: { update: { $set: Record<string, unknown> } };
    };
    expect(op.updateOne.update.$set.images).toBeUndefined();
    expect(r2.putObject).not.toHaveBeenCalled();
  });
});
