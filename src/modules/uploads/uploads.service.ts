import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

@Injectable()
export class UploadsService {
  constructor(private readonly configService: ConfigService) {}

  async saveImages(dataUrls: string[]): Promise<string[]> {
    const dir = join(process.cwd(), 'uploads', 'products');
    await mkdir(dir, { recursive: true });
    const appUrl = this.configService.getOrThrow<string>('appUrl').replace(/\/$/, '');
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
      if (buffer.byteLength > 2_500_000) {
        throw new BadRequestException('Image too large (max ~2.5MB)');
      }

      const filename = `${randomUUID()}.${ext}`;
      await writeFile(join(dir, filename), buffer);
      urls.push(`${appUrl}/uploads/products/${filename}`);
    }

    return urls;
  }
}
