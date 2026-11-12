import { Readable } from 'node:stream';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Put,
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
import { AiProxyError, AiService } from './ai.service';
import type { ConfigPatch } from './ai-config';

function rethrow(e: unknown): never {
  if (e instanceof AiProxyError) {
    // 结构化返回统一错误模型：前端拿到 code/retryable/retryAfterMs 可做友好提示与退避。
    throw new HttpException(
      {
        statusCode: e.status,
        message: e.message,
        error: e.code || 'AiProxyError',
        code: e.code,
        retryable: e.retryable,
        retryAfterMs: e.retryAfterMs,
      },
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

  /** 账号级用量对账（0020）：GET /api/ai/usage?range=7d|30d|all。 */
  @Get('usage')
  usage(@CurrentUser() user: CurrentUserType, @Query('range') range?: string) {
    return this.ai.usageStats(user.id, range || '30d');
  }

  @Get('configs')
  listConfigs(@CurrentUser() user: CurrentUserType) {
    return this.ai.listConfigs(user.id);
  }

  @Put('config')
  async saveConfig(@CurrentUser() user: CurrentUserType, @Body() body: ConfigPatch) {
    try {
      return await this.ai.saveConfig(user.id, undefined, body || {});
    } catch (e) {
      return rethrow(e);
    }
  }

  @Put('config/:provider')
  async saveProviderConfig(
    @CurrentUser() user: CurrentUserType,
    @Param('provider') provider: string,
    @Body() body: ConfigPatch
  ) {
    try {
      return await this.ai.saveConfig(user.id, provider, body || {});
    } catch (e) {
      return rethrow(e);
    }
  }

  @Delete('config')
  clearConfig(@CurrentUser() user: CurrentUserType) {
    return this.ai.clearConfig(user.id);
  }

  @Delete('config/:provider')
  deleteConfig(@CurrentUser() user: CurrentUserType, @Param('provider') provider: string) {
    return this.ai.deleteConfig(user.id, provider);
  }

  @Post('config/:provider/activate')
  @HttpCode(200)
  async activateConfig(@CurrentUser() user: CurrentUserType, @Param('provider') provider: string) {
    try {
      return await this.ai.setActive(user.id, provider);
    } catch (e) {
      return rethrow(e);
    }
  }

  @Post('test')
  @HttpCode(200) // 探活不是创建资源，保持与 v1 /api/ai/test 的 200 契约
  test(@CurrentUser() user: CurrentUserType, @Body() body: { provider?: unknown }) {
    const provider = body?.provider ? String(body.provider) : undefined;
    return this.ai.test(user.id, provider);
  }

  /**
   * 拉取上游可用模型列表（GET {baseUrl}/models 的服务端代理），供前端下拉选择。
   * body 可带尚未保存的 baseUrl / apiKey；留空则用已保存配置。
   */
  @Post('models')
  @HttpCode(200)
  async models(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    try {
      return await this.ai.listModels(user.id, body || {});
    } catch (e) {
      return rethrow(e);
    }
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
