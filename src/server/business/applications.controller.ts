import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BusinessService } from './business.service';

/**
 * 岗位/申请（Application）——「个人求职 Agent 工作台」的聚合根。
 * 一个岗位聚合：公司 + JD + 定制简历 + 投递状态 + 面试阶段 + 状态流水。
 * 均经 BusinessService → TenantDb.forUser，别人的岗位 404。
 */
@Controller('api/applications')
@UseGuards(SessionGuard, RolesGuard)
export class ApplicationsController {
  constructor(@Inject(BusinessService) private readonly biz: BusinessService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.biz.listApplications(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.biz.createApplication(user.id, {
      position: body?.position,
      companyId: body?.companyId,
      jdId: body?.jdId,
      resumeId: body?.resumeId,
      trackerId: body?.trackerId,
      status: body?.status,
      stage: body?.stage,
      followUpAfterDays: body?.followUpAfterDays,
      payload: body?.payload,
    });
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.getApplication(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.biz.updateApplication(user.id, id, {
      position: body?.position,
      companyId: body?.companyId,
      jdId: body?.jdId,
      resumeId: body?.resumeId,
      trackerId: body?.trackerId,
      status: body?.status,
      stage: body?.stage,
      followUpAfterDays: body?.followUpAfterDays,
      payload: body?.payload,
    });
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.deleteApplication(user.id, id);
  }

  @Get(':id/events')
  events(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.listApplicationEvents(user.id, id);
  }
}
