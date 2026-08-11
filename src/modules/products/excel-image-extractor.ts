import { readFile } from 'fs/promises';
import { extname, basename } from 'path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';
import type ExcelJS from 'exceljs';

export type ExtractedRowImage = {
  excelRow: number;
  col: number;
  buffer: Buffer;
  extension: string;
  byteLength: number;
  pixels: number;
};

type MediaFile = {
  path: string;
  name: string;
  buffer: Buffer;
  extension: string;
};

type Candidate = {
  excelRow: number;
  col: number;
  mediaPath: string;
  buffer: Buffer;
  extension: string;
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) =>
    [
      'Relationship',
      'twoCellAnchor',
      'oneCellAnchor',
      'absoluteAnchor',
      'cellImage',
      'sheetData',
      'row',
      'c',
    ].includes(name),
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeZipPath(p: string): string {
  return p.replace(/^\/+/, '').replace(/\\/g, '/');
}

function resolveRelTarget(baseDir: string, target: string): string {
  const cleaned = target.replace(/^\//, '');
  if (cleaned.startsWith('xl/')) return normalizeZipPath(cleaned);
  // rels live in xl/drawings/_rels → ../media/image1.png
  const parts = [...baseDir.split('/').filter(Boolean), ...cleaned.split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function extFromPath(path: string): string {
  const e = extname(path).toLowerCase().replace(/^\./, '');
  if (e === 'jpeg') return 'jpg';
  if (e === 'jpg' || e === 'png' || e === 'webp' || e === 'gif') return e;
  return 'jpg';
}

function cellRefToRowCol(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) return null;
  const letters = m[1]!.toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: Number(m[2]), col: col - 1 };
}

function extractDispImgId(text: string): string | null {
  const m =
    /DISPIMG\s*\(\s*"?(ID_[0-9A-F]{32})"?/i.exec(text) ||
    /(ID_[0-9A-F]{32})/i.exec(text);
  return m?.[1] ? m[1].toUpperCase() : null;
}

function readTextDeep(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  const o = node as Record<string, unknown>;
  if (typeof o['#text'] === 'string') return o['#text'];
  const chunks: string[] = [];
  for (const v of Object.values(o)) {
    const t = readTextDeep(v);
    if (t) chunks.push(t);
  }
  return chunks.join('');
}

async function measurePixels(buffer: Buffer): Promise<number> {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    return (meta.width ?? 0) * (meta.height ?? 0);
  } catch {
    return 0;
  }
}

function parseRels(xml: string, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const doc = xmlParser.parse(xml);
  const rels = asArray(
    doc?.Relationships?.Relationship as
      | Array<Record<string, string>>
      | undefined,
  );
  for (const rel of rels) {
    const id = rel['@_Id'];
    const target = rel['@_Target'];
    if (!id || !target) continue;
    map.set(id, resolveRelTarget(baseDir, target));
  }
  return map;
}

function collectAnchors(
  drawingXml: string,
  ridToMedia: Map<string, string>,
): Array<{ row: number; col: number; mediaPath: string }> {
  const out: Array<{ row: number; col: number; mediaPath: string }> = [];
  const doc = xmlParser.parse(drawingXml);
  const wsDr = doc?.wsDr ?? doc?.WorksheetDrawing ?? doc;
  const anchors = [
    ...asArray(wsDr?.twoCellAnchor),
    ...asArray(wsDr?.oneCellAnchor),
    ...asArray(wsDr?.absoluteAnchor),
  ];

  for (const anchor of anchors) {
    const from = anchor?.from ?? anchor?.From;
    const rowRaw = from?.row ?? from?.Row;
    const colRaw = from?.col ?? from?.Col;
    const row = Number(rowRaw);
    const col = Number(colRaw);
    if (!Number.isFinite(row) || !Number.isFinite(col)) continue;

    const blip =
      anchor?.pic?.blipFill?.blip ??
      anchor?.sp?.blipFill?.blip ??
      anchor?.pic?.blipFill?.Blip;
    const rid =
      blip?.['@_embed'] ??
      blip?.['@_r:embed'] ??
      blip?.['@_Embed'];
    if (!rid || typeof rid !== 'string') continue;
    const mediaPath = ridToMedia.get(rid);
    if (!mediaPath) continue;
    // drawing row/col are 0-based → Excel row is +1
    out.push({ row: Math.floor(row) + 1, col: Math.floor(col), mediaPath });
  }
  return out;
}

/**
 * Extract row→best original image buffers from an .xlsx (ZIP).
 * Prefers xl/media originals via drawings + cellimages/DISPIMG; no upscaling.
 */
export async function extractRowImagesFromXlsx(
  filePath: string,
  options?: {
    workbook?: ExcelJS.Workbook;
    worksheet?: ExcelJS.Worksheet;
  },
): Promise<Map<number, ExtractedRowImage>> {
  const zipBuf = await readFile(filePath);
  const zip = await JSZip.loadAsync(zipBuf);

  const mediaByPath = new Map<string, MediaFile>();
  for (const [rawPath, entry] of Object.entries(zip.files)) {
    const path = normalizeZipPath(rawPath);
    if (!path.startsWith('xl/media/') || entry.dir) continue;
    const buffer = Buffer.from(await entry.async('nodebuffer'));
    if (!buffer.length) continue;
    mediaByPath.set(path, {
      path,
      name: basename(path),
      buffer,
      extension: extFromPath(path),
    });
  }

  const candidates: Candidate[] = [];

  // --- Floating drawings ---
  for (const [rawPath, entry] of Object.entries(zip.files)) {
    const path = normalizeZipPath(rawPath);
    if (!/^xl\/drawings\/drawing\d+\.xml$/i.test(path) || entry.dir) continue;
    const drawingXml = await entry.async('string');
    const relsPath = path.replace(
      /^(xl\/drawings\/)(drawing\d+\.xml)$/i,
      '$1_rels/$2.rels',
    );
    const relsEntry = zip.file(relsPath) || zip.file(`/${relsPath}`);
    if (!relsEntry) continue;
    const ridToMedia = parseRels(await relsEntry.async('string'), 'xl/drawings');
    const anchors = collectAnchors(drawingXml, ridToMedia);
    for (const a of anchors) {
      const media = mediaByPath.get(normalizeZipPath(a.mediaPath));
      if (!media) continue;
      candidates.push({
        excelRow: a.row,
        col: a.col,
        mediaPath: media.path,
        buffer: media.buffer,
        extension: media.extension,
      });
    }
  }

  // --- Cell images / DISPIMG (WPS, Excel 365) ---
  const cellImagesEntry =
    zip.file('xl/cellimages.xml') || zip.file('/xl/cellimages.xml');
  const cellImagesRelsEntry =
    zip.file('xl/_rels/cellimages.xml.rels') ||
    zip.file('/xl/_rels/cellimages.xml.rels');

  const idToMedia = new Map<string, MediaFile>();
  if (cellImagesEntry && cellImagesRelsEntry) {
    const ridToMedia = parseRels(
      await cellImagesRelsEntry.async('string'),
      'xl',
    );
    const cellDoc = xmlParser.parse(await cellImagesEntry.async('string'));
    const images = asArray(
      cellDoc?.cellImages?.cellImage ?? cellDoc?.etc?.cellImages?.cellImage,
    );

    for (const pic of images) {
      const name =
        pic?.pic?.nvPicPr?.cNvPr?.['@_name'] ??
        pic?.xdr?.pic?.nvPicPr?.cNvPr?.['@_name'] ??
        pic?.pic?.nvPicPr?.cNvPr?.['@_id'];
      const rid =
        pic?.pic?.blipFill?.blip?.['@_embed'] ??
        pic?.pic?.blipFill?.blip?.['@_r:embed'];
      if (!name || !rid || typeof rid !== 'string') continue;
      const mediaPath = ridToMedia.get(rid);
      if (!mediaPath) continue;
      const media = mediaByPath.get(normalizeZipPath(mediaPath));
      if (!media) continue;
      const key = String(name).toUpperCase();
      idToMedia.set(key, media);
      const disp = extractDispImgId(String(name));
      if (disp) idToMedia.set(disp, media);
    }
  }

  // Scan first sheet XML for DISPIMG formulas / shared strings
  const sheet1 =
    zip.file('xl/worksheets/sheet1.xml') ||
    zip.file('/xl/worksheets/sheet1.xml');
  if (sheet1 && idToMedia.size) {
    const sheetXml = await sheet1.async('string');
    const sheetDoc = xmlParser.parse(sheetXml);
    const rows = asArray(sheetDoc?.worksheet?.sheetData?.row);

    // shared strings (for cached formula results sometimes stored as shared)
    const sstEntry =
      zip.file('xl/sharedStrings.xml') || zip.file('/xl/sharedStrings.xml');
    const shared: string[] = [];
    if (sstEntry) {
      const sstDoc = xmlParser.parse(await sstEntry.async('string'));
      for (const si of asArray(sstDoc?.sst?.si)) {
        shared.push(readTextDeep(si));
      }
    }

    for (const row of rows) {
      const rowNum = Number(row?.['@_r']);
      if (!Number.isFinite(rowNum)) continue;
      for (const cell of asArray(row?.c)) {
        const ref = String(cell?.['@_r'] || '');
        const pos = cellRefToRowCol(ref);
        const texts: string[] = [];
        if (cell?.f) texts.push(readTextDeep(cell.f));
        if (cell?.v != null) {
          const v = readTextDeep(cell.v);
          if (cell?.['@_t'] === 's' && shared[Number(v)]) {
            texts.push(shared[Number(v)]!);
          } else {
            texts.push(v);
          }
        }
        if (cell?.is) texts.push(readTextDeep(cell.is));

        for (const t of texts) {
          const id = extractDispImgId(t);
          if (!id) continue;
          const media =
            idToMedia.get(id) ||
            idToMedia.get(id.toUpperCase()) ||
            [...idToMedia.entries()].find(([k]) => k.includes(id))?.[1];
          if (!media) continue;
          candidates.push({
            excelRow: rowNum,
            col: pos?.col ?? 1,
            mediaPath: media.path,
            buffer: media.buffer,
            extension: media.extension,
          });
        }
      }
    }
  }

  // --- ExcelJS fallback if ZIP mapping empty ---
  if (!candidates.length && options?.workbook && options?.worksheet) {
    try {
      const images = options.worksheet.getImages() as Array<{
        imageId: string;
        range: {
          tl?: { nativeRow?: number; nativeCol?: number; row?: number; col?: number };
        };
      }>;
      const mediaList = (
        options.workbook.model as unknown as {
          media?: Array<{
            index?: number;
            buffer?: Uint8Array | Buffer;
            extension?: string;
            name?: string;
          }>;
        }
      )?.media;

      for (const meta of images) {
        const nativeRow =
          meta.range?.tl?.nativeRow ?? meta.range?.tl?.row;
        const nativeCol =
          meta.range?.tl?.nativeCol ?? meta.range?.tl?.col ?? 1;
        if (nativeRow == null || !Number.isFinite(nativeRow)) continue;
        const imageId = Number(meta.imageId);
        let buffer: Buffer | undefined;
        let extension = 'jpg';

        if (mediaList?.length) {
          const m =
            mediaList.find((x) => Number(x.index) === imageId) ||
            mediaList[imageId];
          if (m?.buffer) {
            buffer = Buffer.from(m.buffer);
            extension = extFromPath(`.${m.extension || 'jpg'}`);
          }
        }
        if (!buffer) {
          const img = options.workbook.getImage(imageId);
          if (img?.buffer) {
            buffer = Buffer.from(img.buffer);
            extension = extFromPath(`.${img.extension || 'jpg'}`);
          }
        }
        if (!buffer?.length) continue;
        candidates.push({
          excelRow: Math.floor(Number(nativeRow)) + 1,
          col: Math.floor(Number(nativeCol)),
          mediaPath: `exceljs:${imageId}`,
          buffer,
          extension,
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Pick best candidate per row (pixels, then bytes; prefer photo-ish cols 0–3)
  const best = new Map<number, ExtractedRowImage>();

  for (const c of candidates) {
    const pixels = await measurePixels(c.buffer);
    const next: ExtractedRowImage = {
      excelRow: c.excelRow,
      col: c.col,
      buffer: c.buffer,
      extension: c.extension,
      byteLength: c.buffer.byteLength,
      pixels,
    };
    const prev = best.get(c.excelRow);
    if (!prev) {
      best.set(c.excelRow, next);
      continue;
    }
    if (next.pixels !== prev.pixels) {
      if (next.pixels > prev.pixels) best.set(c.excelRow, next);
      continue;
    }
    if (next.byteLength !== prev.byteLength) {
      if (next.byteLength > prev.byteLength) best.set(c.excelRow, next);
      continue;
    }
    // Prefer column closer to photo column (B = 1)
    const prevDist = Math.abs(prev.col - 1);
    const nextDist = Math.abs(next.col - 1);
    if (nextDist < prevDist) best.set(c.excelRow, next);
  }

  return best;
}

/**
 * Preserve original bytes. Only apply EXIF rotate when orientation tag exists;
 * never upscale or re-encode for "quality".
 */
export async function preserveImageBuffer(
  input: Buffer,
  extension: string,
): Promise<{ buffer: Buffer; ext: string }> {
  const ext = (() => {
    const e = (extension || 'jpg').toLowerCase().replace(/^\./, '');
    if (e === 'jpeg') return 'jpg';
    if (e === 'jpg' || e === 'png' || e === 'webp' || e === 'gif') return e;
    return 'jpg';
  })();

  try {
    const meta = await sharp(input, { failOn: 'none' }).metadata();
    if (meta.orientation && meta.orientation >= 2) {
      const pipeline = sharp(input, { failOn: 'none' }).rotate();
      if (ext === 'png' || meta.hasAlpha) {
        return {
          buffer: await pipeline.png({ compressionLevel: 6 }).toBuffer(),
          ext: 'png',
        };
      }
      if (ext === 'webp') {
        return {
          buffer: await pipeline.webp({ quality: 95, effort: 4 }).toBuffer(),
          ext: 'webp',
        };
      }
      return {
        buffer: await pipeline
          .jpeg({ quality: 95, mozjpeg: true, chromaSubsampling: '4:4:4' })
          .toBuffer(),
        ext: 'jpg',
      };
    }
  } catch {
    /* keep original */
  }

  return { buffer: input, ext };
}
