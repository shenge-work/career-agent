import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BusinessService } from './business.service';

/**
 * JD 匹配与派生（一岗一简历主线）。
 *   · analyze：对某份简历 + JD 文本做只读匹配分析；
 *   · derive ：基于主简历 + JD 生成派生简历（不覆盖主简历）。
 * 均经 BusinessService → TenantDb.forUser，别人的简历 404。
 */
@Controller('api/resumes')
@UseGuards(SessionGuard, RolesGuard)
export class JdController {
  constructor(@Inject(BusinessService) private readonly biz: BusinessService) {}

  @Post(':id/jd-analyze')
  analyze(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() body: any
  ) {
    return this.biz.analyzeJd(user.id, id, String(body?.jdText ?? body?.jd ?? ''));
  }

  @Post(':id/audit')
  audit(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() body: any
  ) {
    return this.biz.auditResume(user.id, id, body?.payload);
  }

  @Post(':id/jd-derive')
  derive(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() body: any
  ) {
    return this.biz.deriveResumeFromJd(user.id, id, {
      jdText: body?.jdText,
      jobId: body?.jobId,
      tags: body?.tags,
    });
  }
}
