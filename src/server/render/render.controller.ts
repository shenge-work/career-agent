import { Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { ResumesService } from '../resumes/resumes.service';
import { renderResume } from './legacy-renderer';
import { buildImagePdfHtml } from './legacy-export-html';
import { resumeToFormats } from './formats.service';
import { ImagePdfService } from './image-pdf.service';
import { NoBrowserError, PdfService } from './pdf.service';

/**
 * 渲染 / 导出端点。
 * 隔离铁律：数据一律经 ResumesService.get(userId, id) 取得（内部走 TenantDb.forUser），
 * 别人的简历在这里就是 404，绝不接受「传 payload 直接渲染」的旁路。
 */
@Controller('api/resumes')
@UseGuards(SessionGuard, RolesGuard)
export class RenderController {
  constructor(
    @Inject(ResumesService) private readonly resumes: ResumesService,
    @Inject(PdfService) private readonly pdfService: PdfService,
    @Inject(ImagePdfService) private readonly imagePdfService: ImagePdfService
  ) {}

  /** 独立 A4 HTML，供编辑器左栏 iframe 直接加载（同源，cookie 自动带上）。 */
  @Get(':id/preview')
  async preview(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const row = await this.resumes.get(user.id, id);
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return renderResume(row.payload).html;
  }

  /**
   * PDF 导出（默认矢量版）。
   *   · mode=vector（默认）：Chrome 原生打印，文字可选中、体积小；
   *   · mode=image：v1 截图导出管线，computePageBreaks 的「不切行吸附」保证
   *     切口不落在文字行中间，与编辑器分页线一致；代价是文字不可选、体积大。
   * 两条链路都要真实浏览器；缺失时诚实降级为 501 + 提示，不假装成功。
   */
  @Get(':id/pdf')
  async pdf(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Query('mode') mode: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<Buffer | Record<string, unknown>> {
    // 隔离铁律：无论哪种模式，数据都只从 ResumesService.get(userId, id) 取
    const row = await this.resumes.get(user.id, id);
    const payload: any = row.payload;
    const isImage = mode === 'image';
    const baseName = String(payload?.data?.name || row.title || 'resume')
      .replace(/[\\/:*?"<>|\r\n]/g, '_') + (isImage ? '_图片版' : '');
    try {
      const buf = isImage
        ? (await this.imagePdfService.render(payload)).buffer
        : await this.pdfService.printHtml(renderResume(payload).html);
      reply.type('application/pdf');
      reply.header('Cache-Control', 'no-store');
      reply.header(
        'Content-Disposition',
        "attachment; filename=\"resume.pdf\"; filename*=UTF-8''" + encodeURIComponent(baseName + '.pdf')
      );
      return buf;
    } catch (e) {
      const noBrowser = e instanceof NoBrowserError;
      reply.code(noBrowser ? 501 : 500);
      return {
        error: (e as Error)?.message || 'PDF 生成失败',
        hint: noBrowser
          ? '请安装 Chrome / Edge，或用 CHROME_PATH 指定浏览器路径；也可打开预览后 Ctrl/Cmd+P「另存为 PDF」'
          : isImage
            ? '图片版生成失败，可改用「矢量 PDF」或打开预览后 Ctrl/Cmd+P「另存为 PDF」'
            : '可打开预览后 Ctrl/Cmd+P「另存为 PDF」',
      };
    }
  }

  /**
   * 多格式导出：txt / md / doc（Word）。纯结构化转换，不依赖 Chrome。
   *   · txt  ：纯文本，去 ** 标记；
   *   · md   ：Markdown，** 即加粗、标题层级保留；
   *   · doc  ：HTML 伪装 .doc，Word 可直接打开，保留加粗与标题。
   * 同样经归属校验，别人的简历 404。
   */
  @Get(':id/export')
  async exportText(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Query('format') format: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const row = await this.resumes.get(user.id, id);
    const data: any = row.payload?.data;
    if (!data || !Array.isArray(data.sections)) {
      reply.code(400);
      return '简历内容为空，无法导出';
    }
    const { txt, md, html } = resumeToFormats(data);
    const baseName = String(data.name || row.title || 'resume').replace(/[\\/:*?"<>|\r\n]/g, '_');

    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    // RFC 5987：filename 只允许 ASCII，UTF-8 文件名必须走 filename*。
    // 直接把中文写进 filename="..." 会被 Fastify 以 ERR_INVALID_CHAR 拒绝（文本类导出 500）。
    const enc = (n: string) => {
      const ascii = n.replace(/[^\x21-\x7e]/g, '_');
      return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(n);
    };

    switch (format) {
      case 'md':
        reply.type('text/markdown; charset=utf-8');
        reply.header('Content-Disposition', enc(baseName + '.md'));
        return txt === '' ? '' : md;
      case 'doc':
      case 'docx':
        // 内容仍是 Word 可开的 HTML；用 .doc 后缀最稳妥（.docx 需真实 OOXML 包）。
        reply.type('application/msword; charset=utf-8');
        reply.header('Content-Disposition', enc(baseName + '.doc'));
        return html;
      case 'txt':
      default:
        reply.type('text/plain; charset=utf-8');
        reply.header('Content-Disposition', enc(baseName + '.txt'));
        return txt;
    }
  }

  /**
   * 导出专用页：含 v1 真实截图管线与本地 vendor，打开后自动跑完并下载图片版 PDF。
   * 供「不想让服务端起 Chrome」的场景（用户浏览器自己算）与调试使用。
   * 与 preview 一样经归属校验，别人的简历在这里就是 404。
   */
  @Get(':id/export-page')
  async exportPage(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const row = await this.resumes.get(user.id, id);
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return buildImagePdfHtml(row.payload).html;
  }
}
