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

    // Category separator (no code)
    ws.getCell('E6').value = '003. JESSIKA KERAMIKA';

    ws.getCell('A7').value = 1;
    ws.getCell('C7').value = 'JEC7337-L1';
    ws.getCell('D7').value = '9811537731971';
    ws.getCell('E7').value = 'САЛАТНИЦА JEC7337-L1 (QORA) 1Кор 6шт';
    ws.getCell('F7').value = 6;
    ws.getCell('I7').value = 12.5;
    ws.getCell('J7').value = 12.5;
    ws.getCell('K7').value = 'ТУЗДОН / САЛАТНИЦА';
    ws.getCell('L7').value = '003. JESSIKA KERAMIKA KHP';

    // Note: columns K/L above are wrong index — Группа is col 11, Производитель 12
    // Fix: headers index 10 = Группа (col 11), 11 = Производитель (col 12)
    ws.getCell(7, 11).value = 'ТУЗДОН / САЛАТНИЦА';
    ws.getCell(7, 12).value = '003. JESSIKA KERAMIKA KHP';

    const imgId = wb.addImage({
      buffer: Buffer.from(PNG_1X1) as unknown as ExcelJS.Buffer,
      extension: 'png',
    });
    // Image on product row 7 (0-based row 6), photo column B
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

  it('parses header on row 5, prices, specs, and extracts image', async () => {
    const filePath = await buildSampleWorkbook();

    const createdCats: string[] = [];
    const bulkOps: unknown[] = [];

    const productModel = {
      find: jest.fn((query?: { code?: { $in: string[] } }) => {
        if (query?.code?.$in) {
          return {
            select: () => ({
              lean: () => ({
                exec: async () => [],
              }),
            }),
          };
        }
        // slug load
        return {
          select: () => ({
            lean: () => ({
              exec: async () => [],
            }),
          }),
        };
      }),
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
    };

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

    // Use public path via multer-like file object
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

    const doc = (bulkOps[0] as { insertOne: { document: Record<string, unknown> } })
      .insertOne.document;
    expect(doc.code).toBe('JEC7337-L1');
    expect(doc.price).toBe(12.5);
    expect(doc.wholesalePrice).toBe(12.5);
    expect(doc.stock).toBe(6);
    expect(Array.isArray(doc.images)).toBe(true);
    expect(String((doc.images as string[])[0])).toContain(
      'https://pub-test.r2.dev/products/',
    );
    expect(doc.images).not.toEqual([
      'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=1200&q=80',
    ]);

    const specs = doc.specs as Array<{ label: string; value: string }>;
    expect(specs.some((s) => s.label.includes('Штрих') || s.value === '9811537731971')).toBe(
      true,
    );
    expect(specs.some((s) => s.label.includes('кейсе') && s.value === '6')).toBe(
      true,
    );
  });
});
