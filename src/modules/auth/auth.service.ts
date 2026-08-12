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
import { createHash, randomBytes, randomInt } from 'crypto';
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

interface BotOtpPayload {
  userId: string;
  telegramId: string;
}

interface BotWebLoginPayload {
  userId: string;
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

    // Exact Telegram profile fields — always take latest from Mini App
    const firstName = (tgUser.first_name ?? '').trim() || undefined;
    const lastName = (tgUser.last_name ?? '').trim() || undefined;
    const username = (tgUser.username ?? '').trim().replace(/^@/, '') || undefined;
    const avatarUrl = (tgUser.photo_url ?? '').trim() || undefined;
    const fullName =
      [firstName, lastName].filter(Boolean).join(' ').trim() ||
      username ||
      `User ${tgUser.id}`;

    let user = await this.usersService.findOrCreateByTelegram({
      telegramId: String(tgUser.id),
      fullName,
      firstName,
      lastName,
      username,
      avatarUrl,
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

  /**
   * After Mini App auth: attach phone from WebApp.requestContact() signed payload.
   */
  async linkTelegramContact(userId: string, contactData: string) {
    const current = await this.usersService.findById(userId);
    if (!current.telegramId) {
      throw new BadRequestException('Account is not linked to Telegram');
    }

    const { contact } = this.initDataService.validateContact(contactData);

    if (
      contact.user_id != null &&
      String(contact.user_id) !== current.telegramId
    ) {
      throw new UnauthorizedException('Contact does not belong to this user');
    }

    let user = await this.usersService.linkPhoneFromTelegram(
      userId,
      contact.phone_number,
      current.telegramId,
      {
        firstName: contact.first_name?.trim() || undefined,
        lastName: contact.last_name?.trim() || undefined,
      },
    );

    user = await this.usersService.ensureSuperAdmin(user);

    // Phone may promote to super-admin
    const superPhone = (
      this.configService.get<string>('telegram.superAdminPhone') ?? ''
    ).trim();
    if (
      superPhone &&
      user.phone &&
      normalizeAuthPhone(user.phone) === normalizeAuthPhone(superPhone)
    ) {
      const promoted = await this.usersService.promoteToAdminByPhone(user.phone);
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

  /**
   * Bot «Kod yuborish»: 6 xonali kod (TTL/cooldown default 10 daqiqa).
   */
  async issueBotLoginCode(telegramId: string): Promise<{
    code: string;
    expiresIn: number;
    cooldown: number;
  }> {
    const user = await this.usersService.findByTelegramId(telegramId);
    if (!user?.phone) {
      throw new BadRequestException(
        'Avval botda telefon raqamingizni yuboring',
      );
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account is disabled');
    }

    const ttl =
      this.configService.get<number>('telegram.otpTtlSeconds') ?? 600;
    const cooldownSeconds =
      this.configService.get<number>('telegram.otpCooldownSeconds') ?? 600;

    const cooldownKey = `bot-otp:cooldown:${telegramId}`;
    if (await this.redisService.get(cooldownKey)) {
      throw new HttpException(
        'Yangi kod uchun 10 daqiqa kuting',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const userCodeKey = `bot-otp:user:${telegramId}`;
    const previousCode = await this.redisService.get(userCodeKey);
    if (previousCode) {
      await this.redisService.del(`bot-otp:code:${previousCode}`);
    }

    let code = '';
    for (let i = 0; i < 8; i++) {
      const candidate = String(randomInt(100000, 999999));
      const exists = await this.redisService.get(`bot-otp:code:${candidate}`);
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      throw new BadRequestException('Kod yaratib bo‘lmadi. Qayta urinib ko‘ring');
    }

    const payload: BotOtpPayload = {
      userId: user._id.toString(),
      telegramId,
    };
    await this.redisService.setJson(`bot-otp:code:${code}`, payload, ttl);
    await this.redisService.set(userCodeKey, code, ttl);
    await this.redisService.set(cooldownKey, '1', cooldownSeconds);

    return { code, expiresIn: ttl, cooldown: cooldownSeconds };
  }

  /** Web login: faqat kod (telefon yo‘q). */
  async verifyBotLoginCode(code: string) {
    const normalized = code.trim();
    const key = `bot-otp:code:${normalized}`;
    const payload = await this.redisService.getJson<BotOtpPayload>(key);
    if (!payload?.userId) {
      throw new UnauthorizedException('Kod noto‘g‘ri yoki muddati tugagan');
    }

    await this.redisService.del(
      key,
      `bot-otp:user:${payload.telegramId}`,
    );

    let user = await this.usersService.findById(payload.userId);
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

  /**
   * Open Web: one-time login URL (kod kiritish shart emas).
   */
  async createBotWebLoginUrl(telegramId: string): Promise<string> {
    const user = await this.usersService.findByTelegramId(telegramId);
    if (!user?.phone) {
      throw new BadRequestException(
        'Avval botda telefon raqamingizni yuboring',
      );
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account is disabled');
    }

    const token = createHash('sha256')
      .update(`${telegramId}:${randomBytes(32).toString('hex')}`)
      .digest('hex');
    const payload: BotWebLoginPayload = { userId: user._id.toString() };
    // Link qisqa muddatli (10 daqiqa OTP bilan bir xil)
    const ttl =
      this.configService.get<number>('telegram.otpTtlSeconds') ?? 600;
    await this.redisService.setJson(`bot-web-login:${token}`, payload, ttl);

    // Open Web link shu backend (Redis) bilan bir xil frontendga ketishi kerak.
    // Vercel → onrender API; lokal bot → lokal Redis — shuning uchun lokalda
    // FRONTEND_URL (localhost), prod da TELEGRAM_OPEN_WEB_URL / Mini App URL.
    const openWeb =
      this.configService.get<string>('telegram.openWebUrl')?.trim() ||
      this.configService.get<string>('frontendUrl') ||
      '';
    const frontend = openWeb.replace(/\/$/, '');
    return `${frontend}/login?token=${token}`;
  }

  async consumeBotWebLoginToken(token: string) {
    const key = `bot-web-login:${token.trim()}`;
    const payload = await this.redisService.getJson<BotWebLoginPayload>(key);
    if (!payload?.userId) {
      throw new UnauthorizedException('Link muddati tugagan yoki noto‘g‘ri');
    }
    await this.redisService.del(key);

    let user = await this.usersService.findById(payload.userId);
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
