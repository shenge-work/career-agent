import { BadRequestException, Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { AgentService } from './agent.service';

/**
 * Agent 编排层（N12 S1）：场景化动作，非通用对话。
 *   · parse-jd  ：JD 结构化解析（规则 + 大模型混合，降级规则）；
 *   · gen-pitch ：基于岗位聚合根生成投递话术（大模型 + 模板降级）。
 * 均经 SessionGuard + RolesGuard，跨用户资源（application/resume）由服务层 404。
 */
@Controller('api/agent')
@UseGuards(SessionGuard, RolesGuard)
export class AgentController {
  constructor(@Inject(AgentService) private readonly agent: AgentService) {}

  @Post('parse-jd')
  @HttpCode(200)
  parseJd(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.agent.parseJd(user.id, {
      jdText: body?.jdText,
      resumeId: body?.resumeId,
    });
  }

  @Post('gen-pitch')
  @HttpCode(200)
  genPitch(
    @CurrentUser() user: CurrentUserType,
    @Body() body: any
  ) {
    const applicationId = String(body?.applicationId ?? '').trim();
    if (!applicationId) throw new BadRequestException('applicationId 必填');
    return this.agent.genPitch(user.id, applicationId, { jdText: body?.jdText });
  }

  @Post('review-interview')
  @HttpCode(200)
  reviewInterview(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    const noteId = String(body?.noteId ?? '').trim();
    if (!noteId) throw new BadRequestException('noteId 必填');
    return this.agent.reviewInterview(user.id, noteId);
  }

  @Post('kb-ask')
  @HttpCode(200)
  kbAsk(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    const question = String(body?.question ?? '').trim();
    if (!question) throw new BadRequestException('question 必填');
    return this.agent.kbAsk(user.id, question);
  }
}
