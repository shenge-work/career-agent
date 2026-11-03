import { Readable } from 'node:stream';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { AiProxyError, AiService } from './ai.service';
import type { ConfigPatch } from './ai-config';

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
 * P2b · AI 转发层（替代 tools/serve.js 的 /api/ai/*）。
 * Key 只在服务端：GET 一律返回脱敏配置，PUT 才允许写入；配置与用量按账号隔离。
 */
@Controller('api/ai')
@UseGuards(SessionGuard, RolesGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status(@CurrentUser() user: CurrentUserType) {
    return this.ai.status(user.id);
  }

  @Put('config')
  async saveConfig(@CurrentUser() user: CurrentUserType, @Body() body: ConfigPatch) {
    try {
      return await this.ai.saveConfig(user.id, body || {});
    } catch (e) {
      return rethrow(e);
    }
  }

  @Delete('config')
  clearConfig(@CurrentUser() user: CurrentUserType) {
    return this.ai.clearConfig(user.id);
  }

  @Post('test')
  @HttpCode(200) // 探活不是创建资源，保持与 v1 /api/ai/test 的 200 契约
  test(@CurrentUser() user: CurrentUserType) {
    return this.ai.test(user.id);
  }

  /**
   * SSE 透传：hijack 掉 Fastify 的回复，逐 chunk 把上游字节流 pipe 给浏览器，
   * 不做解析也不缓冲（与 v1 ai-proxy.js 行为一致）。前端断开时取消上游请求。
   */
  @Post('chat')
  async chat(
    @CurrentUser() user: CurrentUserType,
    @Body() body: any,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ) {
    let opened;
    try {
      opened = await this.ai.openChat(user.id, body || {});
    } catch (e) {
      return rethrow(e);
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(opened.upstream.status || 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    req.raw.on('close', () => {
      try {
        opened!.upstream.body?.cancel();
      } catch {
        /* 客户端已断开，忽略 */
      }
    });

    try {
      Readable.fromWeb(opened.upstream.body as any).pipe(raw);
    } catch (e) {
      // Node < 18 没有 Readable.fromWeb；连接已 hijack，只能直接结束流
      raw.end('data: ' + JSON.stringify({ error: '当前 Node 不支持流式转发：' + (e as Error).message }) + '\n\n');
    }
  }
}
