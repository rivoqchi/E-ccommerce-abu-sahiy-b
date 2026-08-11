import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type R2PutInput = {
  /** Object key without leading slash, e.g. products/uuid.jpg */
  key: string;
  body: Buffer;
  contentType: string;
};

@Injectable()
export class R2StorageService implements OnModuleInit {
  private readonly logger = new Logger(R2StorageService.name);
  private client!: S3Client;
  private bucket!: string;
  private publicBaseUrl!: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const r2 = this.configService.getOrThrow<{
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      endpoint: string;
      publicUrl: string;
    }>('r2');

    this.bucket = r2.bucket;
    this.publicBaseUrl = r2.publicUrl.replace(/\/$/, '');
    this.client = new S3Client({
      region: 'auto',
      endpoint: r2.endpoint.replace(/\/$/, ''),
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });

    this.logger.log(`R2 storage ready (bucket=${this.bucket})`);
  }

  /** Public CDN URL for a stored object key */
  publicUrlFor(key: string): string {
    const clean = key.replace(/^\/+/, '');
    return `${this.publicBaseUrl}/${clean}`;
  }

  async putObject(input: R2PutInput): Promise<string> {
    const key = input.key.replace(/^\/+/, '');
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    } catch (err) {
      this.logger.error(`R2 PutObject failed for ${key}: ${String(err)}`);
      throw new InternalServerErrorException(
        'Faylni Cloudflare R2 ga yuklash muvaffaqiyatsiz',
      );
    }
    return this.publicUrlFor(key);
  }
}
