import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import { Role } from '../../common/enums/role.enum';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AddressDto } from './dto/address.dto';
import { PriceTier } from '../../common/enums/price-tier.enum';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { R2StorageService } from '../uploads/r2-storage.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly configService: ConfigService,
    private readonly r2: R2StorageService,
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
      priceTier: PriceTier.Retail,
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
      priceTier: PriceTier.Retail,
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

      // Always mirror latest Telegram profile (name + photo)
      if (data.firstName !== undefined && existing.firstName !== data.firstName) {
        existing.firstName = data.firstName || undefined;
        dirty = true;
      }
      if (data.lastName !== undefined && existing.lastName !== data.lastName) {
        existing.lastName = data.lastName || undefined;
        dirty = true;
      }
      if (data.fullName && existing.fullName !== data.fullName) {
        existing.fullName = data.fullName;
        dirty = true;
      }
      if (data.username !== undefined) {
        const nextUsername = data.username?.replace(/^@/, '') || undefined;
        if (existing.username !== nextUsername) {
          existing.username = nextUsername;
          dirty = true;
        }
      }
      // Always place Telegram's current main profile photo when provided
      if (data.avatarUrl && existing.avatarUrl !== data.avatarUrl) {
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
      username: data.username?.replace(/^@/, '') || undefined,
      avatarUrl: data.avatarUrl,
      role: Role.Customer,
      priceTier: PriceTier.Retail,
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

  /**
   * Attach a Telegram-verified phone to the current Mini App user.
   * If that phone already belongs to another account without a different
   * telegramId, merge into the phone account (canonical) and deactivate the duplicate.
   */
  async linkPhoneFromTelegram(
    userId: string,
    phone: string,
    telegramId: string,
    profile?: { firstName?: string; lastName?: string },
  ): Promise<UserDocument> {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      throw new BadRequestException('Invalid phone number');
    }

    const current = await this.findById(userId);
    if (current.phone === normalized) {
      return current;
    }

    const byPhone = await this.findByPhone(normalized);

    if (!byPhone) {
      current.phone = normalized;
      if (profile?.firstName && !current.firstName) {
        current.firstName = profile.firstName;
      }
      if (profile?.lastName && !current.lastName) {
        current.lastName = profile.lastName;
      }
      if (profile?.firstName || profile?.lastName) {
        const full = [current.firstName, current.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        if (full) current.fullName = full;
      }
      await current.save();
      return current;
    }

    if (byPhone._id.toString() === userId) {
      return current;
    }

    if (byPhone.telegramId && byPhone.telegramId !== telegramId) {
      throw new ConflictException(
        'Phone already linked to another Telegram account',
      );
    }

    // Merge telegram profile into the existing phone account
    byPhone.telegramId = telegramId;
    if (current.username && !byPhone.username) {
      byPhone.username = current.username;
    }
    // Prefer Telegram profile names when phone account is incomplete
    if (current.firstName) {
      byPhone.firstName = current.firstName;
    }
    if (current.lastName) {
      byPhone.lastName = current.lastName;
    }
    if (profile?.firstName) {
      byPhone.firstName = profile.firstName;
    }
    if (profile?.lastName) {
      byPhone.lastName = profile.lastName;
    }
    // Always keep Telegram main photo when available
    if (current.avatarUrl) {
      byPhone.avatarUrl = current.avatarUrl;
    }
    if (current.role === Role.Admin && byPhone.role !== Role.Admin) {
      byPhone.role = Role.Admin;
    }
    if (
      current.priceTier === PriceTier.Wholesale &&
      byPhone.priceTier !== PriceTier.Wholesale
    ) {
      byPhone.priceTier = PriceTier.Wholesale;
    }
    const mergedName = [byPhone.firstName, byPhone.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (mergedName) byPhone.fullName = mergedName;
    await byPhone.save();

    // Free unique telegramId on the duplicate Mini App-only user
    await this.userModel
      .findByIdAndUpdate(userId, {
        $unset: { telegramId: 1, refreshTokenHash: 1 },
        $set: { isActive: false },
      })
      .exec();

    return byPhone;
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

    const rawExt = match[1].toLowerCase();
    const ext = rawExt === 'jpeg' || rawExt === 'jpg' ? 'jpg' : rawExt;
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.byteLength > 1_800_000) {
      throw new BadRequestException('Image too large (max ~1.5MB)');
    }

    const filename = `${userId}.${ext}`;
    const contentType =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : 'image/jpeg';
    const storedUrl = await this.r2.putObject({
      key: `avatars/${filename}`,
      body: buffer,
      contentType,
    });
    const avatarUrl = `${storedUrl}?v=${Date.now()}`;

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
      priceTier: user.priceTier ?? PriceTier.Retail,
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
      priceTier: (u as { priceTier?: PriceTier }).priceTier ?? PriceTier.Retail,
      isActive: u.isActive,
      createdAt: (u as { createdAt?: Date }).createdAt,
    }));
  }

  async adminUpdateUser(id: string, dto: AdminUpdateUserDto) {
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
  const trimmed = phone.trim().replace(/[\s\-()]/g, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  // Telegram contact often sends digits only, e.g. 998901234567
  if (/^\d{8,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}
