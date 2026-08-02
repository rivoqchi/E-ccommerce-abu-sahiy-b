import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Brand } from './schemas/brand.schema';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { slugify } from '../../common/utils/slugify';

@Injectable()
export class BrandsService {
  constructor(
    @InjectModel(Brand.name) private readonly brandModel: Model<Brand>,
  ) {}

  async create(dto: CreateBrandDto) {
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    const exists = await this.brandModel.exists({ slug });
    if (exists) {
      throw new ConflictException('Brand slug already exists');
    }

    const brand = await this.brandModel.create({
      name: dto.name.trim(),
      slug,
      isActive: dto.isActive ?? true,
    });

    return brand.toObject();
  }

  async findAll(activeOnly = false) {
    const filter = activeOnly ? { isActive: true } : {};
    return this.brandModel.find(filter).sort({ name: 1 }).lean().exec();
  }

  async findById(id: string) {
    const brand = await this.brandModel.findById(id).lean().exec();
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async update(id: string, dto: UpdateBrandDto) {
    const $set: Record<string, unknown> = { ...dto };
    if (dto.slug) {
      $set.slug = slugify(dto.slug);
    } else if (dto.name) {
      $set.slug = slugify(dto.name);
      $set.name = dto.name.trim();
    }

    const brand = await this.brandModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .lean()
      .exec();

    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async remove(id: string) {
    const result = await this.brandModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Brand not found');
    return { deleted: true };
  }
}
