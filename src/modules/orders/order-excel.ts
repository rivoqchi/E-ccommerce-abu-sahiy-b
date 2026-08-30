import ExcelJS from 'exceljs';
import { OrderItemFulfillment } from '../../common/enums/order-item-fulfillment.enum';
import { formatNakladnoyCase } from '../../common/utils/product-units';

export type ExcelOrderItem = {
  name: string;
  code?: string;
  quantity: number;
  boxQuantity?: number;
  pieceQuantity?: number;
  piecesPerBox?: number;
  unitPrice: number;
  givenQuantity?: number;
  fulfillmentStatus?: string;
  source?: string;
  partnerName?: string;
  image?: string;
  substitutes?: Array<{
    name: string;
    code?: string;
    quantity: number;
    unitPrice: number;
    source?: string;
    partnerName?: string;
    image?: string;
  }>;
};

export type ExcelOrder = {
  _id: unknown;
  createdAt?: Date | string;
  status: string;
  currency?: string;
  notes?: string;
  subtotal: number;
  shippingFee: number;
  total: number;
  originalTotal?: number;
  items?: ExcelOrderItem[];
  shippingAddress?: {
    fullName?: string;
    phone?: string;
    line1?: string;
    line2?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Kutilmoqda',
  paid: 'Toʻlangan',
  shipped: 'Joʻnatilgan',
  delivered: 'Yetkazilgan',
  cancelled: 'Bekor qilingan',
};

const FILL = {
  ink: 'FF111827',
  head: 'FF111827',
  zebra: 'FFF4F4F5',
  danger: 'FFFEE2E2',
  warn: 'FFFEF3C7',
  total: 'FF111827',
  card: 'FFF8FAFC',
};

const DEFAULT_SKLAD = 'KOROBKA';

function moneyFmt(currency?: string) {
  return currency === 'USD' ? '"$"#,##0.00' : '#,##0';
}

function givenOf(item: ExcelOrderItem) {
  if (item.fulfillmentStatus === OrderItemFulfillment.Unavailable) return 0;
  if (typeof item.givenQuantity === 'number' && Number.isFinite(item.givenQuantity)) {
    return Math.max(0, item.givenQuantity);
  }
  return item.quantity;
}

function lineStatus(item: ExcelOrderItem) {
  const given = givenOf(item);
  if (item.fulfillmentStatus === OrderItemFulfillment.Unavailable || given === 0) {
    return 'Qolmagan';
  }
  if (
    item.fulfillmentStatus === OrderItemFulfillment.Substituted ||
    (item.substitutes?.length ?? 0) > 0
  ) {
    return 'Almashtirilgan';
  }
  if (given < item.quantity) return `${given}/${item.quantity}`;
  return '';
}

function skladOf(item: { source?: string; partnerName?: string }) {
  if (item.source === 'hamkor') return item.partnerName || 'HAMKOR';
  return DEFAULT_SKLAD;
}

function caseQtyOf(item: ExcelOrderItem) {
  const hasUnits =
    (item.boxQuantity != null && item.boxQuantity > 0) ||
    (item.pieceQuantity != null && item.pieceQuantity > 0);
  if (hasUnits) {
    return formatNakladnoyCase(item.boxQuantity, item.pieceQuantity);
  }
  return '—';
}

function formatWhen(value?: Date | string) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function fetchExcelImage(
  url: string,
): Promise<{ buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32 || buf.length > 2_500_000) return null;
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('png') || url.toLowerCase().includes('.png')) {
      return { buffer: buf, extension: 'png' };
    }
    if (ct.includes('gif') || url.toLowerCase().includes('.gif')) {
      return { buffer: buf, extension: 'gif' };
    }
    if (ct.includes('jpeg') || ct.includes('jpg') || url.toLowerCase().includes('.jpg')) {
      return { buffer: buf, extension: 'jpeg' };
    }
    if (ct.includes('webp')) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { buffer: buf, extension: 'png' };
    }
    return { buffer: buf, extension: 'jpeg' };
  } catch {
    return null;
  }
}

function applyHeaderCell(cell: ExcelJS.Cell, text: string) {
  cell.value = text;
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: FILL.head },
  };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = {
    bottom: { style: 'thin', color: { argb: 'FF111827' } },
  };
}

type NakladnoyRow = {
  index: number;
  code: string;
  sklad: string;
  name: string;
  caseQty: string;
  totalPieces: number;
  unitPrice: number;
  summa: number;
  imageUrl?: string;
  status: string;
  isSub: boolean;
};

function collectNakladnoyRows(items: ExcelOrderItem[]): NakladnoyRow[] {
  const rows: NakladnoyRow[] = [];
  let index = 0;

  for (const item of items) {
    index += 1;
    const given = givenOf(item);
    const unavailable =
      item.fulfillmentStatus === OrderItemFulfillment.Unavailable || given === 0;
    const billedQty = unavailable ? 0 : given;
    rows.push({
      index,
      code: item.code?.trim() || '—',
      sklad: skladOf(item),
      name: item.name,
      caseQty: caseQtyOf(item),
      totalPieces: item.quantity,
      unitPrice: item.unitPrice,
      summa: billedQty * item.unitPrice,
      imageUrl: item.image,
      status: lineStatus(item),
      isSub: false,
    });

    for (const sub of item.substitutes ?? []) {
      index += 1;
      rows.push({
        index,
        code: sub.code?.trim() || '—',
        sklad: skladOf(sub),
        name: sub.name,
        caseQty: '—',
        totalPieces: sub.quantity,
        unitPrice: sub.unitPrice,
        summa: sub.quantity * sub.unitPrice,
        imageUrl: sub.image,
        status: 'Almashtirilgan',
        isSub: true,
      });
    }
  }

  return rows;
}

export async function buildOrderWorkbook(
  order: ExcelOrder,
  images: Map<string, { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' }>,
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sami';
  wb.created = new Date();

  const ws = wb.addWorksheet('Nakladnoy', {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 },
    },
    views: [{ state: 'normal', showGridLines: false }],
  });

  ws.columns = [
    { width: 11 },
    { width: 5 },
    { width: 12 },
    { width: 14 },
    { width: 34 },
    { width: 16 },
    { width: 10 },
    { width: 12 },
    { width: 14 },
  ];

  const currency = order.currency === 'USD' ? 'USD' : 'UZS';
  const shortId = String(order._id).slice(-8).toUpperCase();
  const fmt = moneyFmt(order.currency);
  const items = order.items ?? [];
  const nakladnoyRows = collectNakladnoyRows(items);

  ws.mergeCells('A1:I1');
  ws.getCell('A1').value = 'SAMI';
  ws.getCell('A1').font = { name: 'Calibri', size: 22, bold: true, color: { argb: FILL.ink } };
  ws.getRow(1).height = 28;

  ws.mergeCells('A2:I2');
  ws.getCell('A2').value = `Nakladnoy — Buyurtma #${shortId}`;
  ws.getCell('A2').font = { name: 'Calibri', size: 14, bold: true };

  ws.mergeCells('A3:I3');
  ws.getCell('A3').value =
    `${formatWhen(order.createdAt)}  ·  ${STATUS_LABEL[order.status] ?? order.status}  ·  ${currency}`;
  ws.getCell('A3').font = { name: 'Calibri', size: 10, color: { argb: 'FF6B7280' } };

  const addr = order.shippingAddress;
  const address = [addr?.line1, addr?.line2, addr?.city, addr?.country, addr?.postalCode]
    .filter(Boolean)
    .join(', ');

  const info = [
    ['Mijoz', addr?.fullName ?? '—'],
    ['Telefon', addr?.phone ?? '—'],
    ['Manzil', address || '—'],
    ['Izoh', order.notes?.trim() || '—'],
  ];
  info.forEach((pair, i) => {
    const r = 5 + i;
    ws.getCell(`A${r}`).value = pair[0];
    ws.getCell(`A${r}`).font = { bold: true, size: 10, color: { argb: 'FF6B7280' } };
    ws.mergeCells(`B${r}:I${r}`);
    ws.getCell(`B${r}`).value = pair[1];
    ws.getCell(`B${r}`).font = { size: 11 };
    ws.getRow(r).height = 18;
    for (let c = 1; c <= 9; c++) {
      ws.getCell(r, c).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: FILL.card },
      };
    }
  });

  const headerRow = 10;
  const headers = [
    'Rasm',
    '№',
    'Kod',
    'Sklad',
    'Produksiya',
    'Kol-vo v keise',
    'Kol_vo',
    'Narx',
    'Summa',
  ];
  headers.forEach((h, i) => applyHeaderCell(ws.getCell(headerRow, i + 1), h));
  ws.getRow(headerRow).height = 22;

  let row = 11;
  let totalBoxes = 0;
  let totalLoosePieces = 0;
  for (const item of items) {
    totalBoxes += Math.max(0, Math.trunc(item.boxQuantity ?? 0));
    totalLoosePieces += Math.max(0, Math.trunc(item.pieceQuantity ?? 0));
  }

  for (const line of nakladnoyRows) {
    const excelRow = ws.getRow(row);
    excelRow.height = 58;
    excelRow.alignment = { vertical: 'middle' };
    excelRow.font = { name: 'Calibri', size: 10 };

    excelRow.getCell(2).value = line.index;
    excelRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
    excelRow.getCell(3).value = line.code;
    excelRow.getCell(4).value = line.sklad;
    excelRow.getCell(5).value = line.isSub ? `↳ ${line.name}` : line.name;
    excelRow.getCell(5).alignment = { vertical: 'middle', wrapText: true };
    excelRow.getCell(6).value = line.caseQty;
    excelRow.getCell(6).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    excelRow.getCell(7).value = line.totalPieces;
    excelRow.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' };
    excelRow.getCell(8).value = line.unitPrice;
    excelRow.getCell(8).numFmt = fmt;
    excelRow.getCell(9).value = line.status === 'Qolmagan' ? 0 : line.summa;
    excelRow.getCell(9).numFmt = fmt;
    excelRow.getCell(9).font = { bold: true, name: 'Calibri' };

    if (line.status === 'Qolmagan') {
      excelRow.getCell(5).font = { color: { argb: 'FFB91C1C' }, bold: true, size: 10, name: 'Calibri' };
      excelRow.getCell(5).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: FILL.danger },
      };
    } else if (line.status === 'Almashtirilgan' || line.status.includes('/')) {
      excelRow.getCell(5).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: FILL.warn },
      };
    }

    if (row % 2 === 0) {
      for (let c = 1; c <= 9; c++) {
        if (
          c === 5 &&
          (line.status === 'Qolmagan' ||
            line.status === 'Almashtirilgan' ||
            line.status.includes('/'))
        ) {
          continue;
        }
        excelRow.getCell(c).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: FILL.zebra },
        };
      }
    }

    const img = line.imageUrl ? images.get(line.imageUrl) : undefined;
    if (img) {
      const imageId = wb.addImage({
        buffer: img.buffer as unknown as ExcelJS.Buffer,
        extension: img.extension,
      });
      ws.addImage(imageId, {
        tl: { col: 0.15, row: row - 1 + 0.12 },
        ext: { width: 70, height: 70 },
        editAs: 'oneCell',
      });
    }

    row += 1;
  }

  if (!nakladnoyRows.length) {
    ws.mergeCells(`A${row}:I${row}`);
    ws.getCell(`A${row}`).value = 'Mahsulotlar yoʻq';
    row += 1;
  }

  row += 1;
  const totals: Array<[string, string | number, boolean]> = [
    ['Jami kor', `${totalBoxes.toFixed(2).replace(/\.?0+$/, '')} Kor`, false],
    ['Jami dona (alohida)', totalLoosePieces, false],
    ['Yetkazib berish', order.shippingFee, false],
  ];
  if (order.originalTotal != null && order.originalTotal !== order.total) {
    totals.push(['Buyurtma jami', order.originalTotal, false]);
  }
  totals.push(['Yakuniy hisob', order.total, true]);

  for (const [label, value, strong] of totals) {
    ws.mergeCells(`A${row}:H${row}`);
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
    ws.getCell(`A${row}`).font = {
      bold: strong,
      size: strong ? 12 : 10,
      color: { argb: strong ? 'FFFFFFFF' : 'FF6B7280' },
    };
    ws.getCell(`I${row}`).value = value;
    if (typeof value === 'number') {
      ws.getCell(`I${row}`).numFmt = fmt;
    }
    ws.getCell(`I${row}`).font = {
      bold: true,
      size: strong ? 12 : 11,
      color: { argb: strong ? 'FFFFFFFF' : FILL.ink },
    };
    if (strong) {
      for (let c = 1; c <= 9; c++) {
        ws.getCell(row, c).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: FILL.total },
        };
      }
      ws.getRow(row).height = 24;
    }
    row += 1;
  }

  return wb;
}

export async function buildOrdersListWorkbook(
  orders: ExcelOrder[],
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sami';
  const ws = wb.addWorksheet('Buyurtmalar', {
    views: [{ state: 'normal', showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  ws.columns = [
    { width: 12 },
    { width: 20 },
    { width: 22 },
    { width: 42 },
    { width: 16 },
    { width: 10 },
    { width: 16 },
  ];

  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = `SAMI — Buyurtmalar (${orders.length})`;
  ws.getCell('A1').font = { size: 16, bold: true, name: 'Calibri' };
  ws.getRow(1).height = 24;

  const headers = [
    'ID',
    'Sana',
    'Mijoz',
    'Mahsulotlar',
    'Status',
    'Valyuta',
    'Jami',
  ];
  headers.forEach((h, i) => applyHeaderCell(ws.getCell(2, i + 1), h));
  ws.getRow(2).height = 20;

  orders.forEach((order, idx) => {
    const r = ws.getRow(3 + idx);
    const addr = order.shippingAddress;
    const products = (order.items ?? [])
      .map((i) => {
        const st = lineStatus(i);
        const units = caseQtyOf(i);
        const subs = (i.substitutes ?? [])
          .map((s) => `→ ${s.name} ×${s.quantity}`)
          .join(' ');
        return `${i.name} ${units !== '—' ? `(${units})` : `×${i.quantity}`}${st ? ` [${st}]` : ''}${subs ? ` ${subs}` : ''}`;
      })
      .join('; ');
    r.values = [
      String(order._id).slice(-8).toUpperCase(),
      formatWhen(order.createdAt),
      addr?.fullName ?? '—',
      products || '—',
      STATUS_LABEL[order.status] ?? order.status,
      order.currency === 'USD' ? 'USD' : 'UZS',
      order.total,
    ];
    r.getCell(7).numFmt = moneyFmt(order.currency);
    r.alignment = { vertical: 'middle', wrapText: true };
    r.height = 32;
    r.font = { name: 'Calibri', size: 10 };
    if (idx % 2 === 1) {
      r.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: FILL.zebra },
        };
      });
    }
  });

  ws.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: Math.max(2, orders.length + 2), column: 7 },
  };

  return wb;
}
