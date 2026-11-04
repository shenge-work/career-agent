import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { Role } from '../../shared/constants';
import { Roles } from '../auth/decorators';
import { SessionGuard } from '../auth/session.guard';
import { RolesGuard } from '../auth/roles.guard';
import { UsersService } from './users.service';

/** 整个控制器都要求 admin：内测阶段账号由管理员统一开，不做公开注册。 */
@Controller('api/users')
@Roles('admin')
@UseGuards(SessionGuard, RolesGuard)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body() body: any) {
    const role = (body?.role || 'member') as Role;
    return this.users.create({
      email: String(body?.email || ''),
      password: String(body?.password || ''),
      role,
      displayName: body?.displayName ? String(body.displayName) : null,
    });
  }

  @Post(':id/disable')
  disable(@Param('id') id: string) {
    return this.users.disable(id);
  }
}
