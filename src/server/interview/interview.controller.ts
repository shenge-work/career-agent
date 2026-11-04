import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { InterviewService } from './interview.service';

/**
 * 面试复盘 + 面经知识库（N12 S2）。
 * 纯 CRUD + 本地检索，跨用户资源 404；AI 复盘/问答走 /api/agent/*。
 */
@Controller('api')
@UseGuards(SessionGuard, RolesGuard)
export class InterviewController {
  constructor(@Inject(InterviewService) private readonly svc: InterviewService) {}

  // ---------------------------------------------------------- 面试复盘

  @Get('interview-notes')
  listNotes(@CurrentUser() user: CurrentUserType, @Query('applicationId') applicationId?: string) {
    return this.svc.listNotes(user.id, applicationId || undefined);
  }

  @Post('interview-notes')
  createNote(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.svc.createNote(user.id, {
      applicationId: body?.applicationId,
      company: body?.company,
      position: body?.position,
      round: body?.round,
      interviewAt: body?.interviewAt,
      payload: body?.payload,
    });
  }

  @Get('interview-notes/:id')
  getNote(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.getNote(user.id, id);
  }

  @Put('interview-notes/:id')
  updateNote(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateNote(user.id, id, {
      applicationId: body?.applicationId,
      company: body?.company,
      position: body?.position,
      round: body?.round,
      interviewAt: body?.interviewAt,
      payload: body?.payload,
    });
  }

  @Delete('interview-notes/:id')
  deleteNote(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.deleteNote(user.id, id);
  }

  // ---------------------------------------------------------- 面经知识库

  @Get('kb')
  listKb(@CurrentUser() user: CurrentUserType) {
    return this.svc.listKb(user.id);
  }

  @Post('kb')
  createKb(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.svc.createKb(user.id, {
      title: body?.title,
      category: body?.category,
      tags: body?.tags,
      content: body?.content,
    });
  }

  @Get('kb/search')
  searchKb(@CurrentUser() user: CurrentUserType, @Query('q') q?: string, @Query('limit') limit?: string) {
    return this.svc.searchKb(user.id, q || '', limit ? Number(limit) : undefined);
  }

  @Get('kb/:id')
  getKb(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.getKb(user.id, id);
  }

  @Put('kb/:id')
  updateKb(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateKb(user.id, id, {
      title: body?.title,
      category: body?.category,
      tags: body?.tags,
      content: body?.content,
    });
  }

  @Delete('kb/:id')
  deleteKb(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.deleteKb(user.id, id);
  }
}
