import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { User, UserDocument } from './schemas/user.schema';
import { Role } from '../../common/enums/role.enum';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AddressDto } from './dto/address.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly configService: ConfigService,
  ) {}

  async create(data: {
    email: string;
    passwordHash: string;
    fullName: string;
    role?: Role;
  }): Promise<UserDocument> {
    const exists = await this.userModel.exists({ email: data.email });
    if (exists) {
      throw new ConflictException('Email already registered');
    }

    return this.userModel.create({
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      role: data.role ?? Role.Customer,
    });
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  async findByPhone(phone: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ phone }).exec();
  }

  async findByTelegramId(telegramId: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ telegramId }).exec();
  }

  async findOrCreateByPhone(
    phone: string,
    profile?: {
      fullName?: string;
      firstName?: string;
      lastName?: string;
    },
  ): Promise<UserDocument> {
    const normalized = normalizePhone(phone);
    const existing = await this.findByPhone(normalized);
    if (existing) {
      let dirty = false;
      if (profile?.fullName && existing.fullName !== profile.fullName) {
        existing.fullName = profile.fullName;
        dirty = true;
      }
      if (profile?.firstName && existing.firstName !== profile.firstName) {
        existing.firstName = profile.firstName;
        dirty = true;
      }
      if (profile?.lastName && existing.lastName !== profile.lastName) {
        existing.lastName = profile.lastName;
        dirty = true;
      }
      if (dirty) await existing.save();
      return existing;
    }

    return this.userModel.create({
      phone: normalized,
      email: `guest.${normalized.replace(/\D/g, '')}@checkout.local`,
      fullName: profile?.fullName?.trim() || normalized,
      firstName: profile?.firstName?.trim(),
      lastName: profile?.lastName?.trim(),
      role: Role.Customer,
    });
  }

  async findOrCreateByTelegram(data: {
    telegramId: string;
    fullName: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    avatarUrl?: string;
  }): Promise<UserDocument> {
    const existing = await this.findByTelegramId(data.telegramId);
    if (existing) {
      let dirty = false;
      if (data.fullName && existing.fullName !== data.fullName) {
        existing.fullName = data.fullName;
        dirty = true;
      }
      if (data.firstName && existing.firstName !== data.firstName) {
        existing.firstName = data.firstName;
        dirty = true;
      }
      if (data.lastName !== undefined && existing.lastName !== data.lastName) {
        existing.lastName = data.lastName;
        dirty = true;
      }
      if (data.username && existing.username !== data.username) {
        existing.username = data.username;
        dirty = true;
      }
      if (data.avatarUrl && !existing.avatarUrl?.includes('/uploads/avatars/')) {
        existing.avatarUrl = data.avatarUrl;
        dirty = true;
      }
      if (dirty) await existing.save();
      return existing;
    }

    return this.userModel.create({
      telegramId: data.telegramId,
      fullName: data.fullName,
      firstName: data.firstName,
      lastName: data.lastName,
      username: data.username,
      avatarUrl: data.avatarUrl,
      role: Role.Customer,
    });
  }

  async linkTelegramId(
    userId: string,
    telegramId: string,
  ): Promise<UserDocument> {
    const conflict = await this.userModel
      .findOne({ telegramId, _id: { $ne: userId } })
      .exec();
    if (conflict) {
      throw new ConflictException('Telegram account already linked');
    }

    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $set: { telegramId } },
        { new: true },
      )
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findById(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.phone) {
      const conflict = await this.userModel
        .findOne({ phone: dto.phone, _id: { $ne: userId } })
        .exec();
      if (conflict) {
        throw new ConflictException('Phone already in use');
      }
    }

    if (dto.username) {
      const conflict = await this.userModel
        .findOne({
          username: dto.username.replace(/^@/, ''),
          _id: { $ne: userId },
        })
        .exec();
      if (conflict) {
        throw new ConflictException('Username already taken');
      }
    }

    const $set: Record<string, unknown> = { ...dto };
    if (dto.username !== undefined) {
      $set.username = dto.username.replace(/^@/, '') || undefined;
    }

    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const current = await this.findById(userId);
      const firstName = dto.firstName ?? current.firstName ?? '';
      const lastName = dto.lastName ?? current.lastName ?? '';
      $set.firstName = firstName || undefined;
      $set.lastName = lastName || undefined;
      if (!dto.fullName) {
        $set.fullName =
          [firstName, lastName].filter(Boolean).join(' ').trim() ||
          current.fullName;
      }
    }

    const user = await this.userModel
      .findByIdAndUpdate(userId, { $set }, { new: true })
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toPublic(user);
  }

  async updateAvatarFromDataUrl(userId: string, dataUrl: string) {
    const match = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(
      dataUrl,
    );
    if (!match) {
      throw new BadRequestException('Invalid image data URL');
    }

    const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.byteLength > 1_800_000) {
      throw new BadRequestException('Image too large (max ~1.5MB)');
    }

    const dir = join(process.cwd(), 'uploads', 'avatars');
    await mkdir(dir, { recursive: true });
    const filename = `${userId}.${ext === 'jpeg' ? 'jpg' : ext}`;
    const filepath = join(dir, filename);
    await writeFile(filepath, buffer);

    const appUrl = this.configService.getOrThrow<string>('appUrl');
    const avatarUrl = `${appUrl.replace(/\/$/, '')}/uploads/avatars/${filename}?v=${Date.now()}`;

    const user = await this.userModel
      .findByIdAndUpdate(userId, { $set: { avatarUrl } }, { new: true })
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toPublic(user);
  }

  async addAddress(userId: string, dto: AddressDto) {
    const user = await this.findById(userId);

    if (dto.isDefault) {
      user.addresses.forEach((address) => {
        address.isDefault = false;
      });
    }

    user.addresses.push({
      ...dto,
      isDefault: dto.isDefault ?? user.addresses.length === 0,
    });

    await user.save();
    return user.addresses;
  }

  async setRefreshTokenHash(userId: string, hash: string | null) {
    if (hash === null) {
      await this.userModel
        .findByIdAndUpdate(userId, { $unset: { refreshTokenHash: 1 } })
        .exec();
      return;
    }

    await this.userModel
      .findByIdAndUpdate(userId, { $set: { refreshTokenHash: hash } })
      .exec();
  }

  toPublic(user: UserDocument) {
    return {
      id: user._id.toString(),
      email: user.email ?? null,
      phone: user.phone ?? null,
      telegramId: user.telegramId ?? null,
      username: user.username ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl ?? null,
      role: user.role,
      addresses: user.addresses,
      isActive: user.isActive,
      createdAt: (user as UserDocument & { createdAt?: Date }).createdAt,
    };
  }

  async findAllAdmin(q?: string) {
    const filter: Record<string, unknown> = {};
    if (q?.trim()) {
      const term = q.trim();
      filter.$or = [
        { fullName: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { username: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
      ];
    }

    const users = await this.userModel
      .find(filter)
      .select('-passwordHash -refreshTokenHash')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return users.map((u) => ({
      id: u._id.toString(),
      email: u.email ?? null,
      phone: u.phone ?? null,
      telegramId: u.telegramId ?? null,
      username: u.username ?? null,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
      fullName: u.fullName,
      avatarUrl: u.avatarUrl ?? null,
      role: u.role,
      isActive: u.isActive,
      createdAt: (u as { createdAt?: Date }).createdAt,
    }));
  }

  async adminUpdateUser(
    id: string,
    dto: { isActive?: boolean; role?: Role },
  ) {
    const user = await this.userModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toPublic(user);
  }

  async promoteToAdminByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;

    const user = await this.userModel
      .findOneAndUpdate(
        {
          $or: [{ phone: normalized }, { phone: phone.trim() }],
        },
        { $set: { role: Role.Admin, phone: normalized } },
        { new: true },
      )
      .exec();
    return user;
  }

  async ensureSuperAdmin(user: UserDocument): Promise<UserDocument> {
    const superPhone = normalizePhone(
      this.configService.get<string>('telegram.superAdminPhone') ?? '',
    );
    if (!superPhone) return user;
    if (user.role === Role.Admin) return user;

    const userPhone = normalizePhone(user.phone ?? '');
    if (!userPhone || userPhone !== superPhone) return user;

    const promoted = await this.promoteToAdminByPhone(superPhone);
    return promoted ?? user;
  }
}

function normalizePhone(phone: string): string {
  const trimmed = phone.trim().replace(/[\s-]/g, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('998') && trimmed.length >= 12) return `+${trimmed}`;
  return trimmed;
}
