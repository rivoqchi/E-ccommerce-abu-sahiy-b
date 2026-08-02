import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile, rename } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import type { Express } from 'express';

const IMAGE_MAX_BYTES = 2_500_000;
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

@Injectable()
export class UploadsService {
  constructor(private readonly configService: ConfigService) {}

  private appBaseUrl(): string {
    return this.configService.getOrThrow<string>('appUrl').replace(/\/$/, '');
  }

  async saveImages(dataUrls: string[]): Promise<string[]> {
    const dir = join(process.cwd(), 'uploads', 'products');
    await mkdir(dir, { recursive: true });
    const appUrl = this.appBaseUrl();
    const urls: string[] = [];

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
        throw new BadRequestException('Image too large (max ~2.5MB)');
      }

      const filename = `${randomUUID()}.${ext}`;
      await writeFile(join(dir, filename), buffer);
      urls.push(`${appUrl}/uploads/products/${filename}`);
    }

    return urls;
  }

  /**
   * Finalize a multer disk-stored file into uploads/stories or uploads/videos.
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
    } else if (mime.startsWith('video/') || VIDEO_EXTS.has(originalExt)) {
      mediaType = 'video';
      folder = 'videos';
      ext =
        originalExt && VIDEO_EXTS.has(originalExt)
          ? originalExt
          : mime.includes('webm')
            ? '.webm'
            : '.mp4';
    } else {
      throw new BadRequestException(
        'Unsupported file type. Use image (jpg/png/webp) or video (mp4/webm)',
      );
    }

    const dir = join(process.cwd(), 'uploads', folder);
    await mkdir(dir, { recursive: true });
    const filename = `${randomUUID()}${ext}`;
    const dest = join(dir, filename);

    // Multer diskStorage already wrote to file.path — move into final folder
    if (file.path) {
      await rename(file.path, dest);
    } else if (file.buffer) {
      await writeFile(dest, file.buffer);
    } else {
      throw new BadRequestException('Empty file');
    }

    const url = `${this.appBaseUrl()}/uploads/${folder}/${filename}`;

    return {
      url,
      mediaType,
      filename,
      size: file.size,
      mimeType: mime || `${mediaType}/${ext.slice(1)}`,
    };
  }
}
