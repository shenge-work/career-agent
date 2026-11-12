import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { PdfService, NoBrowserError } from '../render/pdf.service';
import { buildBrief, buildBriefHtml } from '../../web/company-intel';
import { BusinessService } from './business.service';

/** 公司档案 + 岗位 JD。所有查询都经 BusinessService → TenantDb.forUser。 */
@Controller('api/companies')
@UseGuards(SessionGuard, RolesGuard)
export class CompaniesController {
  constructor(
    @Inject(BusinessService) private readonly biz: BusinessService,
    @Inject(PdfService) private readonly pdf: PdfService
  ) {}

  // 子资源先注册，避免与 :id 单条路由混淆
  @Get(':id/brief.png')
  async briefPng(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Query('rumors') rumors: string,
    @Query('verdict') verdict: string,
    @Query('interviews') interviews: string,
    @Query('questions') questions: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<Buffer | Record<string, unknown>> {
    const company = await this.biz.getCompany(user.id, id);
    const jds = await this.biz.listCompanyJds(user.id, id);
    const includeRumors = rumors === '1';
    const md = buildBrief(company.payload, jds.map((j: any) => j.payload || {}), {
      includeRumors,
      includeVerdict: verdict === '1',
      includeInterviews: interviews === '1',
      includeQuestions: questions === '1',
    });
    const html = buildBriefHtml(md, { watermark: includeRumors });
    try {
      const buf = await this.pdf.screenshotHtml(html);
      reply.type('image/png');
      reply.header('Cache-Control', 'no-store');
      reply.header(
        'Content-Disposition',
        "attachment; filename=\"brief.png\"; filename*=UTF-8''" +
          encodeURIComponent(String(company.name || '公司').replace(/[\\/:*?"<>|]/g, '_') + '-公司简报.png')
      );
      return buf;
    } catch (e) {
      const noBrowser = e instanceof NoBrowserError;
      reply.code(noBrowser ? 501 : 500);
      return {
        error: (e as Error)?.message || '简报图片生成失败',
        hint: noBrowser ? '请安装 Chrome / Edge，或改用「复制 Markdown」手动整理' : undefined,
      };
    }
  }

  @Get(':id/jds')
  listJds(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.listCompanyJds(user.id, id);
  }

  @Post(':id/jds')
  createJd(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.biz.createCompanyJd(user.id, id, { payload: body?.payload ?? body });
  }

  @Put(':id/jds/:jdId')
  updateJd(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Param('jdId') jdId: string,
    @Body() body: any
  ) {
    return this.biz.updateCompanyJd(user.id, id, jdId, { payload: body?.payload ?? body });
  }

  @Delete(':id/jds/:jdId')
  deleteJd(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Param('jdId') jdId: string
  ) {
    return this.biz.deleteCompanyJd(user.id, id, jdId);
  }

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.biz.listCompanies(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.biz.createCompany(user.id, { name: body?.name, payload: body?.payload ?? body });
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.getCompany(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.biz.updateCompany(user.id, id, { name: body?.name, payload: body?.payload });
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.deleteCompany(user.id, id);
  }
}
