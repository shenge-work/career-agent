import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { SessionGuard } from '../auth/session.guard';
import { RolesGuard } from '../auth/roles.guard';
import { UsersService } from './users.service';

/**
 * 本地自助建号：账号一律平等，没有管理员、没有成员管理。
 *
 * 这里只提供「创建一个独立账号」这一件事，刻意不提供账号列表、他人账号信息、
 * 停用他人账号等任何跨账号视图或管理能力。创建出的账号与创建者无隶属关系，
 * 数据由 TenantDb.forUser(user_id) 行级隔离。
 *
 * 安全性：服务只监听 127.0.0.1，且 main.ts 的回环 Host/Origin 守卫对所有请求生效，
 * 因此「能访问本机服务即可自助建号」不等于 ROADMAP 已否决的公网注册服务。
 */
@Controller('api/users')
@Public()
@UseGuards(SessionGuard, RolesGuard)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Post()
  create(@Body() body: any) {
    return this.users.create({
      email: String(body?.email || ''),
      password: String(body?.password || ''),
      displayName: body?.displayName ? String(body.displayName) : null,
    });
  }
}
