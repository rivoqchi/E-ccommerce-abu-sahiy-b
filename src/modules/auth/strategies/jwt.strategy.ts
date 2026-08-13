import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../../../common/decorators/current-user.decorator';
import { UsersService } from '../../users/users.service';

interface JwtPayload {
  sub: string;
  email?: string | null;
  phone?: string | null;
  telegramId?: string | null;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    let user;
    try {
      user = await this.usersService.findById(payload.sub);
    } catch (err) {
      // Lokal JWT / boshqa DB dagi user Atlas'da yo'q — 404 emas, 401
      if (err instanceof NotFoundException) {
        throw new UnauthorizedException('Invalid token');
      }
      throw err;
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account is disabled');
    }

    const ensured = await this.usersService.ensureSuperAdmin(user);

    return {
      userId: ensured._id.toString(),
      email: ensured.email ?? null,
      phone: ensured.phone ?? null,
      telegramId: ensured.telegramId ?? null,
      role: ensured.role,
    };
  }
}
