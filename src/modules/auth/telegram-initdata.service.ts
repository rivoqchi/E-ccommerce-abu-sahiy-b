import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface ValidatedInitData {
  user: TelegramWebAppUser;
  authDate: number;
  queryId?: string;
}

@Injectable()
export class TelegramInitDataService {
  constructor(private readonly configService: ConfigService) {}

  validate(initData: string): ValidatedInitData {
    const botToken = this.configService.get<string>('telegram.botToken');
    if (!botToken) {
      throw new BadRequestException('Telegram bot is not configured');
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      throw new UnauthorizedException('Missing initData hash');
    }

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const calculatedHash = createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const hashBuf = Buffer.from(hash, 'hex');
    const calcBuf = Buffer.from(calculatedHash, 'hex');

    if (
      hashBuf.length !== calcBuf.length ||
      !timingSafeEqual(hashBuf, calcBuf)
    ) {
      throw new UnauthorizedException('Invalid Telegram initData');
    }

    const authDateRaw = params.get('auth_date');
    if (!authDateRaw) {
      throw new UnauthorizedException('Missing auth_date');
    }

    const authDate = Number(authDateRaw);
    const maxAge =
      this.configService.get<number>('telegram.initDataMaxAgeSeconds') ?? 86400;
    const now = Math.floor(Date.now() / 1000);

    if (!Number.isFinite(authDate) || now - authDate > maxAge) {
      throw new UnauthorizedException('Telegram initData expired');
    }

    const userRaw = params.get('user');
    if (!userRaw) {
      throw new UnauthorizedException('Missing Telegram user');
    }

    let user: TelegramWebAppUser;
    try {
      user = JSON.parse(userRaw) as TelegramWebAppUser;
    } catch {
      throw new UnauthorizedException('Invalid Telegram user payload');
    }

    if (!user?.id) {
      throw new UnauthorizedException('Invalid Telegram user id');
    }

    return {
      user,
      authDate,
      queryId: params.get('query_id') ?? undefined,
    };
  }
}
