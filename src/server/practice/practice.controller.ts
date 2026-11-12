import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { AiProxyError } from '../ai/ai.service';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { PracticeService } from './practice.service';

function rethrow(e: unknown): never {
  if (e instanceof AiProxyError) {
    throw new HttpException(
      { statusCode: e.status, message: e.message, error: e.code || 'AiProxyError', code: e.code },
      e.status
    );
  }
  throw e;
}

/**
 * N14 · AI 面试练习（Practice）。
 * 全部经 SessionGuard + RolesGuard；AI 调用失败由 rethrow 转 HttpException，
 * 未配置 AI 时明确抛 400，前端据此走本地题库 / 自评降级。
 */
@Controller('api/practice')
@UseGuards(SessionGuard, RolesGuard)
export class PracticeController {
  constructor(@Inject(PracticeService) private readonly svc: PracticeService) {}

  @Get('sessions')
  listSessions(@CurrentUser() user: CurrentUserType) {
    return this.svc.listSessions(user.id);
  }

  @Post('sessions')
  createSession(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.svc.createSession(user.id, {
      applicationId: body?.applicationId,
      resumeId: body?.resumeId,
      jdText: body?.jdText,
      questionType: body?.questionType,
      difficulty: body?.difficulty,
      questionCount: body?.questionCount,
    });
  }

  @Get('sessions/:id')
  getSession(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.getSession(user.id, id);
  }

  @Put('sessions/:id/status')
  updateStatus(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateStatus(user.id, id, { status: body?.status });
  }

  @Post('sessions/:id/questions/generate')
  @HttpCode(200)
  async generateQuestions(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() body: any
  ) {
    try {
      return await this.svc.generateQuestions(user.id, id, body?.count);
    } catch (e) {
      return rethrow(e);
    }
  }

  @Post('questions/:id/follow-up')
  @HttpCode(200)
  async followUp(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    try {
      return await this.svc.generateFollowUp(user.id, id, { answerId: body?.answerId });
    } catch (e) {
      return rethrow(e);
    }
  }

  @Post('questions/:id/answers')
  @HttpCode(200)
  async submitFirstAnswer(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() body: any
  ) {
    try {
      return await this.svc.submitFirstAnswer(user.id, id, { answer: body?.answer });
    } catch (e) {
      return rethrow(e);
    }
  }

  @Post('questions/:id/retry')
  @HttpCode(200)
  retryQuestion(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.retryQuestion(user.id, id);
  }

  @Put('answers/:id/draft')
  saveDraft(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.saveDraft(user.id, id, { answer: body?.answer });
  }

  @Post('answers/:id/submit')
  @HttpCode(200)
  submitAnswer(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.submitAnswer(user.id, id, { answer: body?.answer });
  }

  @Post('answers/:id/evaluate')
  @HttpCode(200)
  async evaluate(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    try {
      return await this.svc.evaluateAnswer(user.id, id);
    } catch (e) {
      return rethrow(e);
    }
  }

  @Post('answers/:id/self-evaluate')
  @HttpCode(200)
  selfEvaluate(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.selfEvaluate(user.id, id, { dimensions: body?.dimensions });
  }

  @Post('answers/:id/sample-answer')
  @HttpCode(200)
  async sampleAnswer(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    try {
      return await this.svc.sampleAnswer(user.id, id);
    } catch (e) {
      return rethrow(e);
    }
  }

  @Get('growth')
  growth(
    @CurrentUser() user: CurrentUserType,
    @Query('rubricVersion') rubricVersion?: string,
    @Query('from') from?: string,
    @Query('to') to?: string
  ) {
    return this.svc.growth(user.id, { rubricVersion, from, to });
  }

  @Get('weaknesses')
  listWeaknesses(@CurrentUser() user: CurrentUserType) {
    return this.svc.listWeaknesses(user.id);
  }

  @Post('weaknesses')
  createWeakness(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.svc.createWeakness(user.id, {
      source: body?.source,
      dimension: body?.dimension,
      questionId: body?.questionId,
      interviewNoteId: body?.interviewNoteId,
      reason: body?.reason,
    });
  }

  @Put('weaknesses/:id/status')
  updateWeaknessStatus(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateWeaknessStatus(user.id, id, { status: body?.status });
  }

  @Post('sessions/:id/settle')
  @HttpCode(200)
  settle(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.settleSession(user.id, id);
  }

  @Post('sessions/:id/export-kb')
  @HttpCode(200)
  exportKb(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.exportKb(user.id, id, {
      title: body?.title,
      category: body?.category,
      tags: body?.tags,
    });
  }
}
