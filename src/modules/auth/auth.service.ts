import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RedisService } from '../redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Role } from '../../common/enums/role.enum';
import { TelegramGatewayService } from './telegram-gateway.service';
import { TelegramInitDataService } from './telegram-initdata.service';
import { UserDocument } from '../users/schemas/user.schema';

interface OtpSession {
  requestId: string;
  phone: string;
  createdAt: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly gatewayService: TelegramGatewayService,
    private readonly initDataService: TelegramInitDataService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.usersService.create({
      email: dto.email.toLowerCase(),
      passwordHash,
      fullName: dto.fullName,
      role: Role.Customer,
    });

    const tokens = await this.issueTokens(user);
    await this.persistRefreshToken(user.id, tokens.refreshToken);

    return {
      user: this.usersService.toPublic(user),
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user || !user.isActive || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.issueTokens(user);
    await this.persistRefreshToken(user._id.toString(), tokens.refreshToken);

    return {
      user: this.usersService.toPublic(user),
      ...tokens,
    };
  }

  async sendOtp(phone: string) {
    const cooldownKey = `otp:cooldown:${phone}`;
    const dailyKey = `otp:daily:${phone}:${this.dayKey()}`;
    const sessionKey = `otp:session:${phone}`;

    const cooldown = await this.redisService.get(cooldownKey);
    if (cooldown) {
      throw new HttpException(
        'Please wait before requesting another code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const dailyLimit =
      this.configService.get<number>('telegram.otpDailyLimit') ?? 10;
    const dailyCount = Number((await this.redisService.get(dailyKey)) || '0');
    if (dailyCount >= dailyLimit) {
      throw new HttpException(
        'Daily OTP limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ttl =
      this.configService.get<number>('telegram.otpTtlSeconds') ?? 120;
    const cooldownSeconds =
      this.configService.get<number>('telegram.otpCooldownSeconds') ?? 60;

    const { requestId, mock } =
      await this.gatewayService.sendVerificationMessage(phone, ttl);

    const session: OtpSession = {
      requestId,
      phone,
      createdAt: Date.now(),
    };

    await this.redisService.setJson(sessionKey, session, ttl);
    await this.redisService.set(cooldownKey, '1', cooldownSeconds);
    await this.redisService.set(dailyKey, String(dailyCount + 1), 86400);

    return {
      sent: true,
      phone,
      expiresIn: ttl,
      cooldown: cooldownSeconds,
      ...(mock ? { mock: true } : {}),
    };
  }

  async verifyOtp(phone: string, code: string) {
    const sessionKey = `otp:session:${phone}`;
    const session = await this.redisService.getJson<OtpSession>(sessionKey);

    if (!session?.requestId) {
      throw new BadRequestException('No active verification session');
    }

    const valid = await this.gatewayService.checkVerificationStatus(
      session.requestId,
      code,
    );

    if (!valid) {
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.redisService.del(sessionKey);

    let user = await this.usersService.findOrCreateByPhone(phone);
    user = await this.usersService.ensureSuperAdmin(user);
    // OTP phone is source of truth for bootstrap
    const superPhone = (
      this.configService.get<string>('telegram.superAdminPhone') ?? ''
    ).trim();
    if (superPhone && normalizeAuthPhone(phone) === normalizeAuthPhone(superPhone)) {
      const promoted = await this.usersService.promoteToAdminByPhone(phone);
      if (promoted) user = promoted;
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account is disabled');
    }

    const tokens = await this.issueTokens(user);
    await this.persistRefreshToken(user._id.toString(), tokens.refreshToken);

    return {
      user: this.usersService.toPublic(user),
      ...tokens,
    };
  }

  async loginWithTelegram(initData: string) {
    const { user: tgUser } = this.initDataService.validate(initData);

    const firstName = tgUser.first_name?.trim() || undefined;
    const lastName = tgUser.last_name?.trim() || undefined;
    const fullName =
      [firstName, lastName].filter(Boolean).join(' ').trim() ||
      `User ${tgUser.id}`;

    let user = await this.usersService.findOrCreateByTelegram({
      telegramId: String(tgUser.id),
      fullName,
      firstName,
      lastName,
      username: tgUser.username,
      avatarUrl: tgUser.photo_url,
    });

    user = await this.usersService.ensureSuperAdmin(user);

    if (!user.isActive) {
      throw new UnauthorizedException('Account is disabled');
    }

    const tokens = await this.issueTokens(user);
    await this.persistRefreshToken(user._id.toString(), tokens.refreshToken);

    return {
      user: this.usersService.toPublic(user),
      ...tokens,
    };
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; role: string };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    let user = await this.usersService.findById(payload.sub);
    if (!user.refreshTokenHash) {
      throw new UnauthorizedException('Refresh token revoked');
    }

    const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!matches) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    user = await this.usersService.ensureSuperAdmin(user);
    const tokens = await this.issueTokens(user);
    await this.persistRefreshToken(user._id.toString(), tokens.refreshToken);
    return tokens;
  }

  async logout(userId: string) {
    await this.usersService.setRefreshTokenHash(userId, null);
    return { loggedOut: true };
  }

  private async issueTokens(user: UserDocument) {
    const userId = user._id.toString();
    const payload = {
      sub: userId,
      role: user.role,
      email: user.email ?? null,
      phone: user.phone ?? null,
      telegramId: user.telegramId ?? null,
    };

    const accessExpiresIn =
      this.configService.get<string>('jwt.accessExpiresIn') ?? '15m';
    const refreshExpiresIn =
      this.configService.get<string>('jwt.refreshExpiresIn') ?? '7d';

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('jwt.secret'),
        expiresIn: accessExpiresIn as never,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
        expiresIn: refreshExpiresIn as never,
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private async persistRefreshToken(userId: string, refreshToken: string) {
    if (!refreshToken) {
      throw new BadRequestException('Missing refresh token');
    }
    const hash = await bcrypt.hash(refreshToken, 12);
    await this.usersService.setRefreshTokenHash(userId, hash);
  }

  private dayKey() {
    return new Date().toISOString().slice(0, 10);
  }
}

function normalizeAuthPhone(phone: string): string {
  const trimmed = phone.trim().replace(/[\s-]/g, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('998') && trimmed.length >= 12) return `+${trimmed}`;
  return trimmed;
}
