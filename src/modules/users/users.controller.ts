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

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
  adminUpdate(@Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
    return this.usersService.adminUpdateUser(id, dto);
  }
}
