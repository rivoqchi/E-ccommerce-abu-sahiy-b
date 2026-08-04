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

export interface TelegramContactPayload {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}

export interface ValidatedContactData {
  contact: TelegramContactPayload;
  authDate: number;
}

@Injectable()
export class TelegramInitDataService {
  constructor(private readonly configService: ConfigService) {}

  validate(initData: string): ValidatedInitData {
    const params = this.verifySignedPayload(initData, 'Invalid Telegram initData');

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
      authDate: Number(params.get('auth_date')),
      queryId: params.get('query_id') ?? undefined,
    };
  }

  /** Validates signed payload from WebApp.requestContact(). */
  validateContact(contactData: string): ValidatedContactData {
    const params = this.verifySignedPayload(
      contactData,
      'Invalid Telegram contact data',
    );

    const contactRaw = params.get('contact');
    if (!contactRaw) {
      throw new UnauthorizedException('Missing Telegram contact');
    }

    let contact: TelegramContactPayload;
    try {
      contact = JSON.parse(contactRaw) as TelegramContactPayload;
    } catch {
      throw new UnauthorizedException('Invalid Telegram contact payload');
    }

    if (!contact?.phone_number?.trim()) {
      throw new UnauthorizedException('Missing phone number in contact');
    }

    return {
      contact,
      authDate: Number(params.get('auth_date')),
    };
  }

  private verifySignedPayload(
    payload: string,
    invalidMessage: string,
  ): URLSearchParams {
    const botToken = this.configService.get<string>('telegram.botToken');
    if (!botToken) {
      throw new BadRequestException('Telegram bot is not configured');
    }

    const params = new URLSearchParams(payload);
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
      throw new UnauthorizedException(invalidMessage);
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
      throw new UnauthorizedException('Telegram signed data expired');
    }

    return params;
  }
}
