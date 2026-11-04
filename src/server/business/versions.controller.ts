import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BusinessService } from './business.service';

/**
 * 版本历史挂在某份简历下；列表/新增前都会先校验该简历属于当前用户，
 * 避免用别人的 resumeId 探测版本快照。
 */
@Controller('api/resumes/:resumeId/versions')
@UseGuards(SessionGuard, RolesGuard)
export class VersionsController {
  constructor(@Inject(BusinessService) private readonly biz: BusinessService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType, @Param('resumeId') resumeId: string) {
    return this.biz.listVersions(user.id, resumeId);
  }

  @Post()
  add(
    @CurrentUser() user: CurrentUserType,
    @Param('resumeId') resumeId: string,
    @Body() body: any
  ) {
    return this.biz.addVersion(user.id, resumeId, {
      kind: body?.kind,
      label: body?.label,
      snapshot: body?.snapshot ?? body?.payload,
    });
  }

  /**
   * 恢复某个历史版本到简历正文（PG 版本闭环，取代 v1 飞书「从飞书恢复」）：
   * 恢复前当前内容自动先存为新版本，恢复本身可逆；别人的版本 404。
   */
  @Post(':versionId/restore')
  restore(
    @CurrentUser() user: CurrentUserType,
    @Param('resumeId') resumeId: string,
    @Param('versionId') versionId: string
  ) {
    return this.biz.restoreVersion(user.id, resumeId, versionId);
  }
}
