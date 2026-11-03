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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser, Public } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { SyncError, SyncService } from './sync.service';

function rethrow(e: unknown): never {
  if (e instanceof SyncError) {
    throw new HttpException({ statusCode: e.status, message: e.message, error: 'SyncError' }, e.status);
  }
  throw e;
}

/**
 * P2b 第二期 · 飞书同步 API（替代 v1 tools/serve.js 的 /api/sync/* 与 /api/feishu/*）。
 *
 * 与 v1 的契约差异（迁移注意）：
 * - 所有接口需登录（除 OAuth 回调），凭证与状态按账号隔离、落 PostgreSQL；
 * - 上报改为 POST /api/sync/report/:resumeId —— 简历直接从服务端 DB 读，
 *   不再信任前端载荷（v1 是前端把整份 payload POST 过来）；
 * - OAuth 回调必须携带 start 时签发的 state（v1 不校验 state）。
 */
@Controller('api')
@UseGuards(SessionGuard, RolesGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /* -------------------------------------------------- 同步配置（应用身份） */

  @Get('sync/config')
  async config(@CurrentUser() user: CurrentUserType) {
    return this.sync.status(user.id);
  }

  @Put('sync/config')
  async saveConfig(@CurrentUser() user: CurrentUserType, @Body() body: Record<string, unknown>) {
    try {
      return await this.sync.saveConfig(user.id, body || {});
    } catch (e) {
      return rethrow(e);
    }
  }

  /** 写一行空配置 = 显式停用本账号同步（不回退 v1 的 sync.config.json）。 */
  @Delete('sync/config')
  async clearConfig(@CurrentUser() user: CurrentUserType) {
    return this.sync.clearConfig(user.id);
  }

  /** 验证凭证 + 自动建「简历数据」文件夹 + 默认项直接落库。 */
  @Post('sync/probe')
  @HttpCode(200)
  async probe(@CurrentUser() user: CurrentUserType, @Body() body: { app_id?: string; app_secret?: string }) {
    try {
      return await this.sync.probe(user.id, body || {});
    } catch (e) {
      return rethrow(e);
    }
  }

  /* -------------------------------------------------- 上报 / 版本 / 恢复 */

  @Post('sync/report/:resumeId')
  @HttpCode(200)
  async report(@CurrentUser() user: CurrentUserType, @Param('resumeId') resumeId: string) {
    try {
      return await this.sync.report(user.id, resumeId);
    } catch (e) {
      return rethrow(e);
    }
  }

  @Get('sync/versions')
  async versions(@CurrentUser() user: CurrentUserType, @Query('resumeId') resumeId: string) {
    try {
      return await this.sync.listVersions(user.id, String(resumeId || ''));
    } catch (e) {
      return rethrow(e);
    }
  }

  /** 取回某版本内容文本；前端确认后自行 PUT 写回（v1 同款：不直接覆盖用户数据）。 */
  @Post('sync/restore')
  @HttpCode(200)
  async restore(@CurrentUser() user: CurrentUserType, @Body() body: { resumeId?: string; versionId?: string }) {
    try {
      return await this.sync.getVersion(user.id, String(body?.resumeId || ''), String(body?.versionId || ''));
    } catch (e) {
      return rethrow(e);
    }
  }

  /* -------------------------------------------------- 扫码授权（用户身份） */

  @Post('feishu/oauth/start')
  @HttpCode(200)
  async oauthStart(@CurrentUser() user: CurrentUserType) {
    try {
      return await this.sync.oauthStart(user.id);
    } catch (e) {
      return rethrow(e);
    }
  }

  /**
   * 匿名回调：飞书授权成功后浏览器从 accounts.feishu.cn 302 跨站抵达，
   * 无会话 cookie，靠 start 时签发的 state 找回发起账号。回环守卫对该前缀放行
   * （Host 仍须回环，见 security.ts CROSS_SITE_ALLOWED_PREFIXES）。
   */
  @Public()
  @Get('feishu/oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    reply.type('text/html; charset=utf-8');
    return this.sync.oauthCallback(String(code || ''), String(state || ''));
  }

  @Post('feishu/oauth/revoke')
  @HttpCode(200)
  async oauthRevoke(@CurrentUser() user: CurrentUserType) {
    return this.sync.oauthRevoke(user.id);
  }

  /* -------------------------------------------------- 个人应用注册（Device Flow） */

  @Post('feishu/register/begin')
  @HttpCode(200)
  async registerBegin(@CurrentUser() user: CurrentUserType) {
    try {
      return await this.sync.registerBegin(user.id);
    } catch (e) {
      return rethrow(e);
    }
  }

  @Get('feishu/register/poll')
  async registerPoll(@CurrentUser() user: CurrentUserType, @Query('token') token: string) {
    try {
      return await this.sync.registerPoll(user.id, String(token || ''));
    } catch (e) {
      return rethrow(e);
    }
  }

  @Post('feishu/register/cancel')
  @HttpCode(200)
  async registerCancel(@CurrentUser() user: CurrentUserType, @Query('token') token: string) {
    return this.sync.registerCancel(user.id, String(token || ''));
  }
}
