import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { SnippetService } from './snippet.service';

/**
 * STAR 经历素材库（Snippet）—— 跨简历复用的经历片段。
 *
 * 与简历 / 内推一致：跨用户资源一律 404（不泄露存在性）。
 */
@Controller('api/snippets')
@UseGuards(SessionGuard, RolesGuard)
export class SnippetController {
  constructor(@Inject(SnippetService) private readonly svc: SnippetService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.svc.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.svc.create(user.id, body);
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.get(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(user.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.remove(user.id, id);
  }
}
