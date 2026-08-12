import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { OrdersModule } from '../orders/orders.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramBotController } from './telegram-bot.controller';

@Module({
  imports: [UsersModule, OrdersModule],
  controllers: [TelegramBotController],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramBotModule {}
