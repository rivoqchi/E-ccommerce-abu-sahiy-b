import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { readFile, unlink } from 'fs/promises';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import type { Express } from 'express';
import { R2StorageService } from './r2-storage.service';

const IMAGE_MAX_BYTES = 8_000_000;
/** Large product/demo videos — Range streaming keeps playback smooth */
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);

export type SavedMedia = {
  url: string;
  mediaType: 'image' | 'video';
  filename: string;
  size: number;
  mimeType: string;
};

function imageContentType(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

@Injectable()
export class UploadsService {
  constructor(private readonly r2: R2StorageService) {}

  async saveImages(
    dataUrls: string[],
    folder: 'products' | 'xitoy' = 'products',
  ): Promise<string[]> {
    const urls: string[] = [];
    const prefix = folder.replace(/[^a-z0-9_-]/gi, '') || 'products';

    for (const dataUrl of dataUrls) {
      const match = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(
        dataUrl,
      );
      if (!match) {
        throw new BadRequestException('Invalid image data URL');
      }

      const ext =
        match[1].toLowerCase() === 'jpeg' || match[1].toLowerCase() === 'jpg'
          ? 'jpg'
          : match[1].toLowerCase();
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.byteLength > IMAGE_MAX_BYTES) {
        throw new BadRequestException('Image too large (max ~8MB)');
      }

      const filename = `${randomUUID()}.${ext}`;
      const url = await this.r2.putObject({
        key: `${prefix}/${filename}`,
        body: buffer,
        contentType: imageContentType(ext),
      });
      urls.push(url);
    }

    return urls;
  }

  /** Telegram yoki boshqa manbadan kelgan rasm bufferni saqlash */
  async saveImageBuffer(
    buffer: Buffer,
    ext: 'jpg' | 'png' | 'webp' = 'jpg',
    folder: 'products' | 'xitoy' = 'products',
  ): Promise<string> {
    if (buffer.byteLength > IMAGE_MAX_BYTES) {
      throw new BadRequestException('Image too large (max ~8MB)');
    }

    const prefix = folder.replace(/[^a-z0-9_-]/gi, '') || 'products';
    const filename = `${randomUUID()}.${ext}`;
    return this.r2.putObject({
      key: `${prefix}/${filename}`,
      body: buffer,
      contentType: imageContentType(ext),
    });
  }

  /**
   * Finalize a multer disk-stored file into R2 (stories/ or videos/).
   */
  async saveUploadedMedia(file: Express.Multer.File): Promise<SavedMedia> {
    if (!file) {
      throw new BadRequestException('Empty file');
    }
    if (file.size > VIDEO_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `File too large (max ${VIDEO_MAX_BYTES / (1024 * 1024)}MB)`,
      );
    }

    const mime = (file.mimetype || '').toLowerCase();
    const originalExt = extname(file.originalname || '').toLowerCase();
    let mediaType: 'image' | 'video';
    let folder: string;
    let ext: string;
    let contentType: string;

    if (mime.startsWith('image/') || IMAGE_EXTS.has(originalExt)) {
      mediaType = 'image';
      folder = 'stories';
      if (file.size > IMAGE_MAX_BYTES) {
        throw new BadRequestException('Image too large (max ~2.5MB)');
      }
      ext =
        originalExt && IMAGE_EXTS.has(originalExt)
          ? originalExt === '.jpeg'
            ? '.jpg'
            : originalExt
          : mime.includes('png')
            ? '.png'
            : mime.includes('webp')
              ? '.webp'
              : mime.includes('gif')
                ? '.gif'
                : '.jpg';
      contentType = mime.startsWith('image/')
        ? mime
        : imageContentType(ext.slice(1));
    } else if (mime.startsWith('video/') || VIDEO_EXTS.has(originalExt)) {
      mediaType = 'video';
      folder = 'videos';
      ext =
        originalExt && VIDEO_EXTS.has(originalExt)
          ? originalExt
          : mime.includes('webm')
            ? '.webm'
            : '.mp4';
      contentType =
        mime.startsWith('video/')
          ? mime
          : ext === '.webm'
            ? 'video/webm'
            : 'video/mp4';
    } else {
      throw new BadRequestException(
        'Unsupported file type. Use image (jpg/png/webp) or video (mp4/webm)',
      );
    }

    const filename = `${randomUUID()}${ext}`;
    let body: Buffer;
    if (file.path) {
      body = await readFile(file.path);
      try {
        await unlink(file.path);
      } catch {
        /* temp cleanup best-effort */
      }
    } else if (file.buffer) {
      body = file.buffer;
    } else {
      throw new BadRequestException('Empty file');
    }

    const url = await this.r2.putObject({
      key: `${folder}/${filename}`,
      body,
      contentType,
    });

    return {
      url,
      mediaType,
      filename,
      size: file.size,
      mimeType: contentType,
    };
  }
}
