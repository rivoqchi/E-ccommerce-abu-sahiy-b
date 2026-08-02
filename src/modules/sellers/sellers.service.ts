import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Seller } from './schemas/seller.schema';
import { CreateSellerDto } from './dto/create-seller.dto';
import { UpdateSellerDto } from './dto/update-seller.dto';
import { SellerStatus } from '../../common/enums/seller-status.enum';

function normalizeTelegramUsername(
  value?: string | null,
): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^@+/, '').toLowerCase();
  return cleaned || undefined;
}

@Injectable()
export class SellersService {
  constructor(
    @InjectModel(Seller.name) private readonly sellerModel: Model<Seller>,
  ) {}

  async create(dto: CreateSellerDto) {
    const exists = await this.sellerModel.exists({ phone: dto.phone });
    if (exists) throw new ConflictException('Seller phone already exists');

    const seller = await this.sellerModel.create({
      ...dto,
      telegramUsername: normalizeTelegramUsername(dto.telegramUsername),
      status: dto.status ?? SellerStatus.Active,
    });
    return seller.toObject();
  }

  async findAll(activeOnly = false) {
    const filter = activeOnly ? { status: SellerStatus.Active } : {};
    return this.sellerModel.find(filter).sort({ createdAt: -1 }).lean().exec();
  }

  async update(id: string, dto: UpdateSellerDto) {
    if (dto.phone) {
      const conflict = await this.sellerModel
        .findOne({ phone: dto.phone, _id: { $ne: id } })
        .exec();
      if (conflict) throw new ConflictException('Seller phone already exists');
    }

    const payload: UpdateSellerDto & { telegramUsername?: string } = {
      ...dto,
    };
    if (dto.telegramUsername !== undefined) {
      payload.telegramUsername = normalizeTelegramUsername(
        dto.telegramUsername,
      );
    }

    const seller = await this.sellerModel
      .findByIdAndUpdate(id, { $set: payload }, { new: true })
      .lean()
      .exec();
    if (!seller) throw new NotFoundException('Seller not found');
    return seller;
  }

  async remove(id: string) {
    const result = await this.sellerModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Seller not found');
    return { deleted: true };
  }

  async countAll() {
    return this.sellerModel.countDocuments().exec();
  }
}
