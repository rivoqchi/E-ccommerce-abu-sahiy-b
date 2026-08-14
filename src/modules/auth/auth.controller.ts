import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { TelegramContactDto } from './dto/telegram-contact.dto';
import { VerifyBotOtpDto } from './dto/verify-bot-otp.dto';
import { BotWebLoginDto } from './dto/bot-web-login.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('otp/send')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.phone);
  }

  @Public()
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.code);
  }

  /** Web login: bot yuborgan 6 xonali kod */
  @Public()
  @Post('bot-otp/verify')
  verifyBotOtp(@Body() dto: VerifyBotOtpDto) {
    return this.authService.verifyBotLoginCode(dto.code);
  }

  /** Open Web token → JWT (TTL ichida qayta urinishga ruxsat) */
  @Public()
  @SkipThrottle()
  @Post('bot-web-login')
  botWebLogin(@Body() dto: BotWebLoginDto) {
    return this.authService.consumeBotWebLoginToken(dto.token);
  }

  @Public()
  @Post('telegram')
  telegramAuth(@Body() dto: TelegramAuthDto) {
    return this.authService.loginWithTelegram(dto.initData);
  }

  @UseGuards(JwtAuthGuard)
  @Post('telegram/contact')
  linkTelegramContact(
    @CurrentUser() user: AuthUser,
    @Body() dto: TelegramContactDto,
  ) {
    return this.authService.linkTelegramContact(user.userId, dto.contactData);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@CurrentUser() user: AuthUser) {
    return this.authService.logout(user.userId);
  }
}
