import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnauthorizedException,
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
import {
  ApprovalStatus,
  approvalActorName,
  isApprovedForAccess,
  resolveApprovalStatus,
} from '../../common/enums/approval-status.enum';
import { AuthUser } from '../../common/decorators/current-user.decorator';

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
      approvalStatus: ApprovalStatus.Approved,
    });
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  async findByPhone(phone: string): Promise<UserDocument | null> {
    const variants = phoneLookupVariants(phone);
    if (!variants.length) return null;
    return this.userModel.findOne({ phone: { $in: variants } }).exec();
  }

  async findByTelegramId(telegramId: string): Promise<UserDocument | null> {
    const id = String(telegramId).trim();
    if (!id) return null;
    const asNum = Number(id);
    // string + (legacy) number saqlangan telegramId
    const filter =
      Number.isFinite(asNum) && String(asNum) === id
        ? { $or: [{ telegramId: id }, { telegramId: String(asNum) }] }
        : { telegramId: id };
    return this.userModel.findOne(filter).exec();
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
      if (existing.phone !== normalized) {
        existing.phone = normalized;
        dirty = true;
      }
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
      email: guestEmailForPhone(normalized),
      fullName: profile?.fullName?.trim() || normalized,
      firstName: profile?.firstName?.trim(),
      lastName: profile?.lastName?.trim(),
      role: Role.Customer,
      priceTier: PriceTier.Retail,
      approvalStatus: ApprovalStatus.Pending,
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
      approvalStatus: ApprovalStatus.Pending,
    });
  }

  /**
   * Bot contact share: find/create user by phone and bind telegramId.
   * Caller must verify contact.user_id === message.from.id before calling.
   */
  async registerFromBotContact(data: {
    telegramId: string;
    phone: string;
    firstName?: string;
    lastName?: string;
    username?: string;
  }): Promise<UserDocument> {
    const telegramId = String(data.telegramId).trim();
    const normalized = normalizePhone(data.phone);
    if (!normalized || normalized.replace(/\D/g, '').length < 8) {
      throw new BadRequestException('Invalid phone number');
    }

    const fullName =
      [data.firstName, data.lastName].filter(Boolean).join(' ').trim() ||
      normalized;
    const username = data.username?.replace(/^@/, '') || undefined;
    const guestEmail = guestEmailForPhone(normalized);

    const applyProfile = async (user: UserDocument) => {
      let dirty = false;
      if (user.phone !== normalized) {
        user.phone = normalized;
        dirty = true;
      }
      if (!user.email) {
        user.email = guestEmail;
        dirty = true;
      }
      if (username && user.username !== username) {
        user.username = username;
        dirty = true;
      }
      if (data.firstName && user.firstName !== data.firstName) {
        user.firstName = data.firstName;
        dirty = true;
      }
      if (data.lastName && user.lastName !== data.lastName) {
        user.lastName = data.lastName;
        dirty = true;
      }
      if (fullName && user.fullName !== fullName) {
        user.fullName = fullName;
        dirty = true;
      }
      if (String(user.telegramId ?? '') !== telegramId) {
        user.telegramId = telegramId;
        dirty = true;
      }
      if (dirty) {
        try {
          await user.save();
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;

          // telegramId/phone/email conflict — mavjud yozuvni qaytaramiz
          const owner =
            (await this.findByTelegramId(telegramId)) ||
            (await this.findByPhoneOrGuestEmail(normalized, guestEmail));
          if (owner) {
            return this.ensureSuperAdmin(owner);
          }

          // username unique (eski index) — username ni tashlab qayta
          if (username) {
            user.username = undefined;
            await user.save();
          } else {
            throw err;
          }
        }
      }
      return this.ensureSuperAdmin(user);
    };

    try {
      const byTelegram = await this.findByTelegramId(telegramId);
      if (byTelegram) {
        const samePhone =
          byTelegram.phone && phonesMatch(byTelegram.phone, normalized);

        if (samePhone) {
          return applyProfile(byTelegram);
        }

        try {
          const linked = await this.linkPhoneFromTelegram(
            byTelegram._id.toString(),
            normalized,
            telegramId,
            { firstName: data.firstName, lastName: data.lastName },
          );
          return applyProfile(linked);
        } catch (err) {
          if (err instanceof ConflictException) throw err;
          const byPhone = await this.findByPhoneOrGuestEmail(
            normalized,
            guestEmail,
          );
          if (
            byPhone &&
            (!byPhone.telegramId ||
              String(byPhone.telegramId) === telegramId)
          ) {
            return applyProfile(byPhone);
          }
          // Allaqachon shu telegramId bilan user bor — muvaffaqiyat
          const again = await this.findByTelegramId(telegramId);
          if (again) return applyProfile(again);
          throw err;
        }
      }

      const existing = await this.findByPhoneOrGuestEmail(
        normalized,
        guestEmail,
      );
      if (existing) {
        if (
          existing.telegramId &&
          String(existing.telegramId) !== telegramId
        ) {
          throw new ConflictException(
            'Phone already linked to another Telegram account',
          );
        }
        return applyProfile(existing);
      }

      try {
        const created = await this.userModel.create({
          phone: normalized,
          telegramId,
          email: guestEmail,
          fullName,
          firstName: data.firstName?.trim() || undefined,
          lastName: data.lastName?.trim() || undefined,
          username,
          role: Role.Customer,
          priceTier: PriceTier.Retail,
          approvalStatus: ApprovalStatus.Pending,
        });
        return this.ensureSuperAdmin(created);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;

        const raced = await this.findByPhoneOrGuestEmail(
          normalized,
          guestEmail,
        );
        if (
          raced &&
          (!raced.telegramId || String(raced.telegramId) === telegramId)
        ) {
          return applyProfile(raced);
        }

        const byTg = await this.findByTelegramId(telegramId);
        if (byTg) {
          return applyProfile(byTg);
        }

        throw new ConflictException(
          'Phone already linked to another Telegram account',
        );
      }
    } catch (err) {
      // Oxirgi himoya: E11000 telegramId — user allaqachon bor
      if (isDuplicateKeyError(err)) {
        const owner =
          (await this.findByTelegramId(telegramId)) ||
          (await this.findByPhoneOrGuestEmail(normalized, guestEmail));
        if (owner) {
          return this.ensureSuperAdmin(owner);
        }
      }
      throw err;
    }
  }

  private async findByPhoneOrGuestEmail(
    phone: string,
    guestEmail: string,
  ): Promise<UserDocument | null> {
    const byPhone = await this.findByPhone(phone);
    if (byPhone) return byPhone;
    return this.userModel.findOne({ email: guestEmail.toLowerCase() }).exec();
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

    // Avval eski userdan telegramId ni bo‘shatamiz (unique index), keyin phone
    // akkauntga biriktiramiz — aks holda E11000 duplicate key chiqadi.
    await this.userModel
      .findByIdAndUpdate(userId, {
        $unset: { telegramId: 1, refreshTokenHash: 1 },
        $set: { isActive: false },
      })
      .exec();

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
      ...this.approvalPublicFields(user),
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
      ...this.approvalPublicFields(u),
      createdAt: (u as { createdAt?: Date }).createdAt,
    }));
  }

  async adminUpdateUser(id: string, dto: AdminUpdateUserDto, actor?: AuthUser) {
    const { approvalStatus, isActive, ...rest } = dto;

    if (approvalStatus === ApprovalStatus.Approved) {
      await this.approveUser(id, actor);
    } else if (approvalStatus === ApprovalStatus.Blocked) {
      await this.blockUser(id, actor);
    } else if (isActive === false) {
      await this.blockUser(id, actor);
    } else if (isActive === true) {
      await this.approveUser(id, actor);
    }

    if (Object.keys(rest).length) {
      const user = await this.userModel
        .findByIdAndUpdate(id, { $set: rest }, { new: true })
        .exec();
      if (!user) {
        throw new NotFoundException('User not found');
      }
      return this.toPublic(user);
    }

    return this.toPublic(await this.findById(id));
  }

  async approveUser(id: string, actor?: AuthUser): Promise<UserDocument> {
    const user = await this.findById(id);
    const name = await this.resolveActorName(actor);
    user.approvalStatus = ApprovalStatus.Approved;
    user.isActive = true;
    user.approvedById = actor?.userId;
    user.approvedByName = name;
    user.approvedAt = new Date();
    user.blockedById = undefined;
    user.blockedByName = undefined;
    user.blockedAt = undefined;
    await user.save();
    return user;
  }

  async blockUser(id: string, actor?: AuthUser): Promise<UserDocument> {
    const user = await this.findById(id);
    const name = await this.resolveActorName(actor);
    user.approvalStatus = ApprovalStatus.Blocked;
    user.isActive = false;
    user.blockedById = actor?.userId;
    user.blockedByName = name;
    user.blockedAt = new Date();
    await user.save();
    return user;
  }

  async setApprovalNotifyMessages(
    id: string,
    messages: { chatId: string; messageId: number }[],
  ) {
    const user = await this.userModel
      .findByIdAndUpdate(
        id,
        { $set: { approvalNotifyMessages: messages } },
        { new: true },
      )
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findAdminsWithTelegram(): Promise<UserDocument[]> {
    return this.userModel
      .find({
        role: Role.Admin,
        telegramId: { $exists: true, $nin: [null, ''] },
      })
      .exec();
  }

  needsApprovalNotify(user: UserDocument): boolean {
    return (
      resolveApprovalStatus(user) === ApprovalStatus.Pending &&
      !(user.approvalNotifyMessages?.length > 0)
    );
  }

  assertCanLogin(user: {
    approvalStatus?: ApprovalStatus | string;
    isActive?: boolean;
  }) {
    const status = resolveApprovalStatus(user);
    if (status === ApprovalStatus.Pending) {
      throw new UnauthorizedException('Profilingiz hali tasdiqlanmagan');
    }
    if (status === ApprovalStatus.Blocked || user.isActive === false) {
      throw new UnauthorizedException('Profilingiz bloklangan');
    }
    if (!isApprovedForAccess(user)) {
      throw new UnauthorizedException('Profilingiz hali tasdiqlanmagan');
    }
  }

  async promoteToAdminByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;

    const user = await this.userModel
      .findOneAndUpdate(
        {
          $or: [{ phone: normalized }, { phone: phone.trim() }],
        },
        {
          $set: {
            role: Role.Admin,
            phone: normalized,
            approvalStatus: ApprovalStatus.Approved,
            isActive: true,
          },
        },
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

    const userPhone = normalizePhone(user.phone ?? '');
    if (!userPhone || userPhone !== superPhone) return user;

    if (user.role !== Role.Admin) {
      const promoted = await this.promoteToAdminByPhone(superPhone);
      return this.ensureApprovedRecord(promoted ?? user);
    }
    return this.ensureApprovedRecord(user);
  }

  private async ensureApprovedRecord(
    user: UserDocument,
  ): Promise<UserDocument> {
    if (isApprovedForAccess(user)) return user;
    user.approvalStatus = ApprovalStatus.Approved;
    user.isActive = true;
    if (!user.approvedByName) {
      user.approvedByName = 'Tizim';
      user.approvedAt = new Date();
    }
    await user.save();
    return user;
  }

  private async resolveActorName(actor?: AuthUser): Promise<string> {
    if (!actor?.userId) return 'Admin';
    try {
      const admin = await this.findById(actor.userId);
      return approvalActorName(admin);
    } catch {
      return 'Admin';
    }
  }

  private approvalPublicFields(user: {
    approvalStatus?: ApprovalStatus | string;
    isActive?: boolean;
    approvedById?: string;
    approvedByName?: string;
    approvedAt?: Date;
    blockedById?: string;
    blockedByName?: string;
    blockedAt?: Date;
  }) {
    const approvalStatus = resolveApprovalStatus(user);
    return {
      approvalStatus,
      approvedById: user.approvedById ?? null,
      approvedByName: user.approvedByName ?? null,
      approvedAt: user.approvedAt ?? null,
      blockedById: user.blockedById ?? null,
      blockedByName: user.blockedByName ?? null,
      blockedAt: user.blockedAt ?? null,
    };
  }
}

function normalizePhone(phone: string): string {
  let trimmed = phone.trim().replace(/[\s\-()]/g, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('00')) trimmed = `+${trimmed.slice(2)}`;
  if (trimmed.startsWith('+')) return trimmed;
  // Telegram contact: 998901234567
  if (/^998\d{9}$/.test(trimmed)) return `+${trimmed}`;
  // Local UZ mobile without country: 901234567
  if (/^9\d{8}$/.test(trimmed)) return `+998${trimmed}`;
  if (/^\d{8,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

function phoneLookupVariants(phone: string): string[] {
  const normalized = normalizePhone(phone);
  const digits = normalized.replace(/\D/g, '');
  const variants = new Set<string>();
  const raw = phone.trim().replace(/[\s\-()]/g, '');
  if (raw) variants.add(raw);
  if (normalized) variants.add(normalized);
  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
  }
  if (/^998\d{9}$/.test(digits)) {
    variants.add(digits.slice(3)); // 9XXXXXXXX
  }
  if (/^9\d{8}$/.test(digits)) {
    variants.add(`998${digits}`);
    variants.add(`+998${digits}`);
  }
  return [...variants].filter(Boolean);
}

function phonesMatch(a: string, b: string): boolean {
  const da = normalizePhone(a).replace(/\D/g, '');
  const db = normalizePhone(b).replace(/\D/g, '');
  return Boolean(da && db && da === db);
}

function guestEmailForPhone(phone: string): string {
  return `guest.${normalizePhone(phone).replace(/\D/g, '')}@checkout.local`;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: number;
    message?: string;
    cause?: { code?: number; message?: string };
  };
  if (e.code === 11000 || e.cause?.code === 11000) return true;
  const msg = `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  return msg.includes('E11000');
}
