import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { HamkorPartner } from './schemas/hamkor-partner.schema';
import { CreateHamkorPartnerDto } from './dto/create-hamkor-partner.dto';
import { UpdateHamkorPartnerDto } from './dto/update-hamkor-partner.dto';
import { slugify } from '../../common/utils/slugify';
import { RedisService } from '../redis/redis.service';

const LIST_CACHE_KEY = 'hamkor:partners:list';

@Injectable()
export class HamkorPartnersService {
  constructor(
    @InjectModel(HamkorPartner.name)
    private readonly partnerModel: Model<HamkorPartner>,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async create(dto: CreateHamkorPartnerDto) {
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    const exists = await this.partnerModel.exists({ slug });
    if (exists) {
      throw new ConflictException('Hamkor slug allaqachon mavjud');
    }

    const partner = await this.partnerModel.create({
      name: dto.name.trim(),
      slug,
      image: dto.image,
      isActive: dto.isActive ?? true,
      sortOrder: dto.sortOrder ?? 0,
    });

    await this.invalidateCache();
    return partner.toObject();
  }

  async findAll(activeOnly = true) {
    const cacheKey = `${LIST_CACHE_KEY}:${activeOnly ? 'active' : 'all'}`;
    const cached = await this.redis.getJson<unknown[]>(cacheKey);
    if (cached) return cached;

    const filter = activeOnly ? { isActive: true } : {};
    const items = await this.partnerModel
      .find(filter)
      .sort({ sortOrder: 1, name: 1 })
      .lean()
      .exec();

    const ttl = this.configService.get<number>('cacheTtlSeconds', 60);
    await this.redis.setJson(cacheKey, items, ttl);
    return items;
  }

  async findById(id: string) {
    const partner = await this.partnerModel.findById(id).lean().exec();
    if (!partner) {
      throw new NotFoundException('Hamkor topilmadi');
    }
    return partner;
  }

  async findBySlug(slug: string) {
    const partner = await this.partnerModel.findOne({ slug }).lean().exec();
    if (!partner) {
      throw new NotFoundException('Hamkor topilmadi');
    }
    return partner;
  }

  async update(id: string, dto: UpdateHamkorPartnerDto) {
    const $set: Record<string, unknown> = { ...dto };
    if (dto.slug) {
      $set.slug = slugify(dto.slug);
    } else if (dto.name) {
      $set.slug = slugify(dto.name);
      $set.name = dto.name.trim();
    }

    const partner = await this.partnerModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .lean()
      .exec();

    if (!partner) {
      throw new NotFoundException('Hamkor topilmadi');
    }

    await this.invalidateCache();
    return partner;
  }

  async remove(id: string) {
    const result = await this.partnerModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException('Hamkor topilmadi');
    }
    await this.invalidateCache();
    return { deleted: true };
  }

  private async invalidateCache() {
    await this.redis.delByPattern('hamkor:partners:*');
    await this.redis.delByPattern('hamkor:categories:*');
    await this.redis.delByPattern('hamkor:products:*');
  }
}
