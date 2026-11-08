import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BlobTooLargeError } from '../storage/blob-store';
import { AttachmentService } from './attachments.service';

/** 只有这几类允许 inline；其余一律 attachment + CSP sandbox。 */
const INLINE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/**
 * 附件端点。
 *
 * 隔离铁律：所有元数据都经 AttachmentService → TenantDb.forUser(userId)，
 * 别人的附件在这里就是 404；blob 路径只由库里查出的 sha256 派生，
 * 任何用户输入（filename / id / owner）都不参与拼路径。
 * 绝不静态直挂 blobs 目录（会绕过会话鉴权，且 SVG/HTML 会变成存储型 XSS）。
 */
@Controller('api/attachments')
@UseGuards(SessionGuard, RolesGuard)
export class AttachmentsController {
  constructor(@Inject(AttachmentService) private readonly svc: AttachmentService) {}

  /** multipart 上传，字段名 file；归属走 query，避免额外 part 解析。 */
  @Post()
  async upload(
    @CurrentUser() user: CurrentUserType,
    @Req() req: FastifyRequest,
    @Query('ownerType') ownerType?: string,
    @Query('ownerId') ownerId?: string
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException('请使用 multipart/form-data 上传');
    }
    try {
      const part = await req.file();
      if (!part) throw new BadRequestException('缺少 file 字段');
      return await this.svc.upload(user.id, part.file, part.filename, { ownerType, ownerId });
    } catch (e: any) {
      if (
        e instanceof BlobTooLargeError ||
        e?.code === 'FST_REQ_FILE_TOO_LARGE' ||
        e?.code === 'FST_FILES_LIMIT'
      ) {
        throw new PayloadTooLargeException(e?.message || '文件过大');
      }
      throw e;
    }
  }

  @Get()
  list(
    @CurrentUser() user: CurrentUserType,
    @Query('ownerType') ownerType?: string,
    @Query('ownerId') ownerId?: string
  ) {
    return this.svc.list(user.id, { ownerType, ownerId });
  }

  /** 同步增量（放在 :id 之前）：云端 / 另一台设备按 nextCursor 续拉。 */
  @Get('sync/changes')
  changes(
    @CurrentUser() user: CurrentUserType,
    @Query('since') since?: string,
    @Query('limit') limit?: string
  ) {
    const n = Number(limit);
    return this.svc.changes(user.id, since || '', Number.isFinite(n) && n > 0 ? n : 500);
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.get(user.id, id);
  }

  /** 字节流：鉴权 + nosniff + CSP sandbox + 强制下载（非图片/PDF）。 */
  @Get(':id/raw')
  async raw(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const { row, stream } = await this.svc.open(user.id, id);
    const inline = INLINE_MIMES.has(row.mime);
    const name = row.originalName || 'attachment';
    const ascii = name.replace(/[^\x21-\x7e]/g, '_').replace(/["\\;]/g, '_');

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') +
        '; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name)
    );
    reply.type(row.mime === 'text/plain' ? 'text/plain; charset=utf-8' : row.mime);
    reply.send(stream);
  }

  /** 软删除：写墓碑 + outbox，不删 blob。 */
  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.remove(user.id, id);
  }
}
