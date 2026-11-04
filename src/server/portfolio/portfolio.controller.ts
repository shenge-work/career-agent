import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { PortfolioService } from './portfolio.service';

/**
 * N13 · 个人作品集站点（Portfolio）。
 * 一次配置，可反复生成静态站 / 反复发布到 GitHub Pages。
 * 均经 PortfolioService → TenantDb.forUser，别人的作品集 404。
 */
@Controller('api/portfolios')
@UseGuards(SessionGuard, RolesGuard)
export class PortfolioController {
  constructor(@Inject(PortfolioService) private readonly svc: PortfolioService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.svc.list(user.id);
  }

  @Get('templates')
  templates(@CurrentUser() user: CurrentUserType) {
    return this.svc.templates();
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.svc.create(user.id, { title: body?.title, templateId: body?.templateId });
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.get(user.id, id);
  }

  @Get(':id/render')
  render(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.render(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(user.id, id, {
      title: body?.title,
      templateId: body?.templateId,
      layout: body?.layout,
      payload: body?.payload,
    });
  }

  /** S2 · 一键发布到 GitHub Pages（git CLI）。 */
  @Post(':id/deploy')
  deploy(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.deploy(user.id, id, {
      repo: body?.repo,
      branch: body?.branch,
      message: body?.message,
    });
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.remove(user.id, id);
  }
}
