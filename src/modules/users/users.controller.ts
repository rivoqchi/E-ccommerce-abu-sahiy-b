import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAvatarDto } from './dto/update-avatar.dto';
import { AddressDto } from './dto/address.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { ApprovalStatus } from '../../common/enums/approval-status.enum';
import { TelegramBotService } from '../telegram-bot/telegram-bot.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @UseGuards(RolesGuard)
  @Roles(Role.Admin)
  @Get()
  findAll(@Query('q') q?: string) {
    return this.usersService.findAllAdmin(q);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    let doc = await this.usersService.findById(user.userId);
    doc = await this.usersService.ensureSuperAdmin(doc);
    return this.usersService.toPublic(doc);
  }

  @Patch('me')
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    await this.usersService.updateProfile(user.userId, dto);
    let doc = await this.usersService.findById(user.userId);
    doc = await this.usersService.ensureSuperAdmin(doc);
    return this.usersService.toPublic(doc);
  }

  @Post('me/avatar')
  updateAvatar(@CurrentUser() user: AuthUser, @Body() dto: UpdateAvatarDto) {
    return this.usersService.updateAvatarFromDataUrl(user.userId, dto.dataUrl);
  }

  @Post('me/addresses')
  addAddress(@CurrentUser() user: AuthUser, @Body() dto: AddressDto) {
    return this.usersService.addAddress(user.userId, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.Admin)
  @Patch(':id')
  async adminUpdate(
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
    @CurrentUser() admin: AuthUser,
  ) {
    const user = await this.usersService.adminUpdateUser(id, dto, admin);
    if (
      dto.approvalStatus === ApprovalStatus.Approved ||
      dto.approvalStatus === ApprovalStatus.Blocked ||
      dto.isActive === true ||
      dto.isActive === false
    ) {
      try {
        const bot = this.moduleRef.get(TelegramBotService, { strict: false });
        await bot.applyAccessDecision(id);
      } catch {
        /* bot o‘chiq bo‘lsa panel baribir saqlaydi */
      }
    }
    return user;
  }
}
