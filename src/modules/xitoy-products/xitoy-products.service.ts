import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateXitoyProductDto } from './dto/create-xitoy-product.dto';
import { UpdateXitoyProductDto } from './dto/update-xitoy-product.dto';
import { XitoyProduct } from './schemas/xitoy-product.schema';
import { calculateXitoyCostPrice } from './xitoy-pricing';

function withComputedPricing(
  dto: CreateXitoyProductDto | UpdateXitoyProductDto,
  existing?: XitoyProduct,
) {
  const chinaPriceYuan = dto.chinaPriceYuan ?? existing!.chinaPriceYuan;
  const cubicM3 = dto.cubicM3 ?? existing!.cubicM3;
  const weightKg = dto.weightKg ?? existing!.weightKg;
  const yuanRate = dto.yuanRate ?? existing!.yuanRate;
  const yuanRateUnit = dto.yuanRateUnit ?? existing!.yuanRateUnit ?? 'yuan';
  const customsFee = dto.customsFee ?? existing!.customsFee;

  const pricing = calculateXitoyCostPrice({
    chinaPriceYuan,
    cubicM3,
    weightKg,
    yuanRate,
    yuanRateUnit,
    customsFee,
  });

  return {
    wholesalePrice: pricing.costPriceUsd,
    costPriceYuan: pricing.costPriceYuan ?? 0,
  };
}

@Injectable()
export class XitoyProductsService {
  constructor(
    @InjectModel(XitoyProduct.name)
    private readonly xitoyProductModel: Model<XitoyProduct>,
    private readonly realtimeService: RealtimeService,
  ) {}

  async findAll() {
    const items = await this.xitoyProductModel
      .find()
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return items.map((item) => this.enrichPricing(item));
  }

  private enrichPricing(item: XitoyProduct & { _id: unknown }) {
    const pricing = calculateXitoyCostPrice({
      chinaPriceYuan: item.chinaPriceYuan,
      cubicM3: item.cubicM3,
      weightKg: item.weightKg,
      yuanRate: item.yuanRate,
      yuanRateUnit: item.yuanRateUnit ?? 'yuan',
      customsFee: item.customsFee,
    });

    return {
      ...item,
      wholesalePrice: pricing.costPriceUsd,
      costPriceYuan: pricing.costPriceYuan,
    };
  }

  async findById(id: string) {
    const item = await this.xitoyProductModel.findById(id).lean().exec();
    if (!item) throw new NotFoundException('Xitoy mahsulot topilmadi');
    return item;
  }

  async create(dto: CreateXitoyProductDto) {
    const yuanRateUnit = dto.yuanRateUnit ?? 'yuan';
    const yuanRate = dto.yuanRate ?? 0;
    const pricing = calculateXitoyCostPrice({
      chinaPriceYuan: dto.chinaPriceYuan,
      cubicM3: dto.cubicM3,
      weightKg: dto.weightKg,
      yuanRate,
      yuanRateUnit,
      customsFee: dto.customsFee,
    });

    const item = await this.xitoyProductModel.create({
      imageUrl: dto.imageUrl.trim(),
      name: dto.name.trim(),
      chinaPriceYuan: dto.chinaPriceYuan,
      cubicM3: dto.cubicM3,
      weightKg: dto.weightKg,
      wholesalePrice: pricing.costPriceUsd,
      costPriceYuan: pricing.costPriceYuan ?? 0,
      yuanRate,
      yuanRateUnit,
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
    const existing = await this.xitoyProductModel.findById(id).exec();
    if (!existing) throw new NotFoundException('Xitoy mahsulot topilmadi');

    const $set: Record<string, unknown> = { ...dto };
    if (dto.name) $set.name = dto.name.trim();
    if (dto.imageUrl) $set.imageUrl = dto.imageUrl.trim();

    const hasPricingField =
      dto.chinaPriceYuan != null ||
      dto.cubicM3 != null ||
      dto.weightKg != null ||
      dto.yuanRate != null ||
      dto.yuanRateUnit != null ||
      dto.customsFee != null;

    if (hasPricingField) {
      Object.assign($set, withComputedPricing(dto, existing));
    }

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
