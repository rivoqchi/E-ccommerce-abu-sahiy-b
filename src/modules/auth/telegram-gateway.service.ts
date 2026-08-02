import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'crypto';

interface GatewayOkResponse<T> {
  ok: true;
  result: T;
}

interface GatewayErrorResponse {
  ok: false;
  error: string;
}

type GatewayResponse<T> = GatewayOkResponse<T> | GatewayErrorResponse;

export interface SendVerificationResult {
  requestId: string;
  mock?: boolean;
}

@Injectable()
export class TelegramGatewayService {
  private readonly logger = new Logger(TelegramGatewayService.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.getOrThrow<string>('telegram.gatewayUrl');
  }

  isMock(): boolean {
    return this.configService.get<boolean>('telegram.gatewayMock') === true;
  }

  async sendVerificationMessage(
    phoneE164: string,
    ttlSeconds: number,
  ): Promise<SendVerificationResult> {
    if (this.isMock()) {
      const code =
        this.configService.get<string>('telegram.gatewayMockCode') ||
        String(randomInt(100000, 999999));
      const requestId = `mock_${createHash('sha256')
        .update(`${phoneE164}:${Date.now()}`)
        .digest('hex')
        .slice(0, 24)}`;

      this.logger.warn(
        `[GATEWAY_MOCK] OTP for ${phoneE164}: ${code} (requestId=${requestId})`,
      );

      return { requestId, mock: true };
    }

    const token = this.configService.get<string>('telegram.gatewayToken');
    if (!token) {
      throw new ServiceUnavailableException(
        'Telegram Gateway is not configured',
      );
    }

    const result = await this.post<{
      request_id: string;
      phone_number: string;
      request_cost?: number;
    }>('sendVerificationMessage', token, {
      phone_number: phoneE164,
      code_length: 6,
      ttl: ttlSeconds,
      payload: 'sami_login',
    });

    return { requestId: result.request_id };
  }

  async checkVerificationStatus(
    requestId: string,
    code: string,
  ): Promise<boolean> {
    if (requestId.startsWith('mock_') || this.isMock()) {
      const expected =
        this.configService.get<string>('telegram.gatewayMockCode') || '123456';
      return code === expected;
    }

    const token = this.configService.get<string>('telegram.gatewayToken');
    if (!token) {
      throw new ServiceUnavailableException(
        'Telegram Gateway is not configured',
      );
    }

    const result = await this.post<{
      request_id: string;
      verification_status?: {
        status: string;
        code_entered?: string;
      };
    }>('checkVerificationStatus', token, {
      request_id: requestId,
      code,
    });

    const status = result.verification_status?.status;
    return status === 'code_valid';
  }

  private async post<T>(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(
        `Gateway ${method} network error: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException('Telegram Gateway unavailable');
    }

    const data = (await response.json()) as GatewayResponse<T>;

    if (!data.ok) {
      this.logger.warn(`Gateway ${method} failed: ${data.error}`);
      throw new BadRequestException(
        data.error || 'Telegram Gateway request failed',
      );
    }

    return data.result;
  }
}
