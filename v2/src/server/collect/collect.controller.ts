import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { CollectService } from './collect.service';

/** P2b · BOSS 聊天采集（替代 tools/serve.js 的 /api/collect-chat）。 */
@Controller('api/collect')
@UseGuards(SessionGuard, RolesGuard)
export class CollectController {
  constructor(private readonly collect: CollectService) {}

  @Get('status')
  status() {
    return this.collect.status();
  }

  @Post('chat')
  @HttpCode(200) // 采集是「并入既有记录」，不是创建资源
  chat(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.collect.collect(user.id, body || {});
  }
}
