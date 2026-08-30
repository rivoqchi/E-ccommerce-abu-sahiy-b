import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateXitoyProductDto } from './dto/create-xitoy-product.dto';
import { UpdateXitoyProductDto } from './dto/update-xitoy-product.dto';
import { XitoyProduct } from './schemas/xitoy-product.schema';

@Injectable()
export class XitoyProductsService {
  constructor(
    @InjectModel(XitoyProduct.name)
    private readonly xitoyProductModel: Model<XitoyProduct>,
    private readonly realtimeService: RealtimeService,
  ) {}

  async findAll() {
    return this.xitoyProductModel
      .find()
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async findById(id: string) {
    const item = await this.xitoyProductModel.findById(id).lean().exec();
    if (!item) throw new NotFoundException('Xitoy mahsulot topilmadi');
    return item;
  }

  async create(dto: CreateXitoyProductDto) {
    const item = await this.xitoyProductModel.create({
      imageUrl: dto.imageUrl.trim(),
      name: dto.name.trim(),
      chinaPriceYuan: dto.chinaPriceYuan,
      cubicM3: dto.cubicM3,
      weightKg: dto.weightKg,
      wholesalePrice: dto.wholesalePrice,
      yuanRate: dto.yuanRate,
      customsFee: dto.customsFee,
    });

    const result = item.toObject();
    this.realtimeService.emitXitoyProductChanged({
      action: 'created',
      item: result,
    });
    return result;
  }

  async update(id: string, dto: UpdateXitoyProductDto) {
    const $set: Record<string, unknown> = { ...dto };
    if (dto.name) $set.name = dto.name.trim();
    if (dto.imageUrl) $set.imageUrl = dto.imageUrl.trim();

    const item = await this.xitoyProductModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .lean()
      .exec();

    if (!item) throw new NotFoundException('Xitoy mahsulot topilmadi');

    this.realtimeService.emitXitoyProductChanged({
      action: 'updated',
      item,
    });
    return item;
  }

  async remove(id: string) {
    const result = await this.xitoyProductModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Xitoy mahsulot topilmadi');

    this.realtimeService.emitXitoyProductChanged({
      action: 'deleted',
      itemId: id,
    });
    return { deleted: true };
  }
}
