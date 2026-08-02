import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CartService } from './cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

@Controller('cart')
@Public()
@UseGuards(OptionalJwtAuthGuard)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  getCart(
    @CurrentUser() user: AuthUser | undefined,
    @Headers('x-guest-id') guestId?: string,
  ) {
    return this.cartService.getCart(user?.userId, guestId);
  }

  @Post('items')
  addItem(
    @Body() dto: AddCartItemDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers('x-guest-id') guestId?: string,
  ) {
    return this.cartService.addItem(dto, user?.userId, guestId);
  }

  @Patch('items/:productId')
  updateItem(
    @Param('productId') productId: string,
    @Body() dto: UpdateCartItemDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers('x-guest-id') guestId?: string,
  ) {
    return this.cartService.updateItem(
      productId,
      dto.quantity,
      user?.userId,
      guestId,
    );
  }

  @Delete()
  clear(
    @CurrentUser() user: AuthUser | undefined,
    @Headers('x-guest-id') guestId?: string,
  ) {
    return this.cartService.clear(user?.userId, guestId);
  }
}
