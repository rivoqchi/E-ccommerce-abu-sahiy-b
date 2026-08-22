import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cart, CartDocument } from './schemas/cart.schema';
import { ProductsService } from '../products/products.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { RedisService } from '../redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { UsersService } from '../users/users.service';
import { PriceTier } from '../../common/enums/price-tier.enum';
import { resolveUnitPrice } from '../../common/utils/pricing';
import { isStorefrontReadyProduct } from '../products/product-completeness';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

@Injectable()
export class CartService {
  constructor(
    @InjectModel(Cart.name) private readonly cartModel: Model<Cart>,
    private readonly productsService: ProductsService,
    private readonly usersService: UsersService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly exchangeRate: ExchangeRateService,
  ) {}

  async getCart(userId?: string, guestId?: string) {
    const cart = await this.findOrCreate(userId, guestId);
    return this.toResponse(cart);
  }

  private async tierFor(userId?: string): Promise<PriceTier> {
    if (!userId) return PriceTier.Retail;
    try {
      const user = await this.usersService.findById(userId);
      return user.priceTier ?? PriceTier.Retail;
    } catch {
      return PriceTier.Retail;
    }
  }

  async addItem(dto: AddCartItemDto, userId?: string, guestId?: string) {
    const product = await this.productsService.findById(dto.productId);
    if (!isStorefrontReadyProduct(product)) {
      throw new BadRequestException('Mahsulot mavjud emas');
    }
    if (product.stock < dto.quantity) {
      throw new BadRequestException('Insufficient stock');
    }

    const tier = await this.tierFor(userId);
    const rate = await this.exchangeRate.getRate();
    const unitPrice = resolveUnitPrice(product, tier, rate);

    const cart = await this.findOrCreate(userId, guestId);
    const existing = cart.items.find(
      (item) => item.productId.toString() === dto.productId,
    );

    if (existing) {
      existing.quantity += dto.quantity;
      existing.unitPrice = unitPrice;
      if (existing.quantity > product.stock) {
        throw new BadRequestException('Insufficient stock');
      }
    } else {
      cart.items.push({
        productId: new Types.ObjectId(dto.productId),
        quantity: dto.quantity,
        unitPrice,
        name: product.name,
        slug: product.slug,
        image: product.images?.[0],
      });
    }

    await cart.save();
    await this.cacheAndEmit(cart, userId, guestId);
    return this.toResponse(cart);
  }

  async updateItem(
    productId: string,
    quantity: number,
    userId?: string,
    guestId?: string,
  ) {
    const cart = await this.findOrCreate(userId, guestId);
    const item = cart.items.find((i) => i.productId.toString() === productId);
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    if (quantity === 0) {
      cart.items = cart.items.filter(
        (i) => i.productId.toString() !== productId,
      );
    } else {
      const product = await this.productsService.findById(productId);
      if (product.stock < quantity) {
        throw new BadRequestException('Insufficient stock');
      }
      const tier = await this.tierFor(userId);
      const rate = await this.exchangeRate.getRate();
      item.quantity = quantity;
      item.unitPrice = resolveUnitPrice(product, tier, rate);
    }

    await cart.save();
    await this.cacheAndEmit(cart, userId, guestId);
    return this.toResponse(cart);
  }

  async clear(userId?: string, guestId?: string) {
    const cart = await this.findOrCreate(userId, guestId);
    cart.items = [];
    await cart.save();
    await this.cacheAndEmit(cart, userId, guestId);
    return this.toResponse(cart);
  }

  async getCartDocument(userId?: string, guestId?: string) {
    return this.findOrCreate(userId, guestId);
  }

  private async findOrCreate(userId?: string, guestId?: string) {
    if (!userId && !guestId) {
      throw new BadRequestException('userId or guestId is required');
    }

    const filter = userId
      ? { userId: new Types.ObjectId(userId) }
      : { guestId };

    let cart = await this.cartModel.findOne(filter).exec();
    if (!cart) {
      cart = await this.cartModel.create(filter);
    }
    return cart;
  }

  private toResponse(cart: CartDocument) {
    const subtotal = cart.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );

    return {
      id: cart._id.toString(),
      userId: cart.userId?.toString(),
      guestId: cart.guestId,
      items: cart.items,
      subtotal,
      itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  private async cacheAndEmit(
    cart: CartDocument,
    userId?: string,
    guestId?: string,
  ) {
    const payload = this.toResponse(cart);
    const key = userId ? `cart:user:${userId}` : `cart:guest:${guestId}`;
    await this.redis.setJson(key, payload, 3600);
    this.realtime.emitCartUpdated(userId ?? guestId ?? 'guest', payload);
  }
}
