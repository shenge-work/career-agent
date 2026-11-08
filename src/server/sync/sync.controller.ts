import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import {
  TenantDb,
  type ConflictDismissResult,
  type ConflictRestoreResult,
} from '../tenant/tenant-db';
import { BLOB_STORE, type BlobStore } from '../storage/blob-store';
import { DB_TOKEN } from '../../shared/constants';
import type { Database } from '../db/client';
import { SyncCloudService } from './sync-cloud.service';

/**
 * 0011/0012 冲突地基的本地窗口 + 云同步（Sync Engine）的编排入口。
 *
 * 云同步四接口：
 *   GET  /api/sync/status   是否启用、游标、最近一次结果
 *   POST /api/sync/enable   { recoveryCode } 建 vault（或加入）+ 基线全量首传
 *   POST /api/sync/run      手动触发一轮 push/pull/GC
 *   POST /api/sync/disable  停用（本地数据保留）
 *
 * 全部经 SessionGuard；跨用户数据一律 404。
 */
@Controller('api/sync')
@UseGuards(SessionGuard, RolesGuard)
export class SyncController {
  constructor(
    @Inject(TenantDb) private readonly tenant: TenantDb,
    private readonly cloud: SyncCloudService
  ) {}

  /** 冲突快照列表：可按 entity / entityId / status 过滤，最多 200 条。 */
  @Get('conflicts')
  conflicts(
    @CurrentUser() user: CurrentUserType,
    @Query('entity') entity?: string,
    @Query('entityId') entityId?: string,
    @Query('status') status?: string
  ) {
    return this.tenant.forUser(user.id).listConflictSnapshots({
      entity: entity?.slice(0, 80),
      entityId: entityId?.slice(0, 200),
      status: status?.slice(0, 20),
    });
  }

  /** 单条快照详情（含落败方整行原文）。 */
  @Get('conflicts/:id')
  async conflict(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    const rows = await this.tenant.forUser(user.id).getConflictSnapshot(id);
    if (!rows.length) throw new NotFoundException('冲突快照不存在');
    return rows[0];
  }

  /**
   * 把落败方版本恢复为当前版本。
   * 语义：新的一次本地写（新 HLC + 本机设备 + change_log），当前版本自动留底。
   */
  @Post('conflicts/:id/restore')
  @HttpCode(200)
  async restore(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    const result = await this.tenant.forUser(user.id).restoreConflictSnapshot(id);
    if (!result.ok) return this.fail(result);
    return result;
  }

  /** 忽略：只把状态改成 dismissed，快照原文永久保留。 */
  @Delete('conflicts/:id')
  @HttpCode(200)
  async dismiss(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    const result = await this.tenant.forUser(user.id).dismissConflictSnapshot(id);
    if (!result.ok) return this.fail(result);
    return result;
  }

  /** 某条投递记录的 append-only 聊天事件（将来跨设备合并聊天记录的事实源）。 */
  @Get('chat-events')
  chatEvents(@CurrentUser() user: CurrentUserType, @Query('trackerId') trackerId?: string) {
    if (!trackerId) return [];
    return this.tenant.forUser(user.id).listTrackerChatEvents(trackerId.slice(0, 200));
  }

  // ------------------------------------------------------------ 云同步（Sync Engine）

  @Get('status')
  status(@CurrentUser() user: CurrentUserType) {
    return this.cloud.status(user.id);
  }

  /**
   * 启用云同步。响应里的 recoveryCode 只回显这一次 —— E2EE 下服务端无法找回，
   * 用户必须当场抄写保存（另一台设备加入全靠它）。
   */
  @Post('enable')
  @HttpCode(200)
  async enable(
    @CurrentUser() user: CurrentUserType,
    @Body('recoveryCode') recoveryCode?: string
  ) {
    if (!recoveryCode || typeof recoveryCode !== 'string') {
      throw new BadRequestException('请输入恢复码（8 组 × 8 位十六进制）');
    }
    try {
      return await this.cloud.enable(user.id, recoveryCode);
    } catch (err: any) {
      if (err?.status === 409) throw new ConflictException(err.message);
      if (err?.message?.includes('恢复码必须是')) throw new BadRequestException(err.message);
      throw new BadRequestException(`启用失败：${err?.message || err}`);
    }
  }

  /** 手动同步一轮（pull → push → GC）。 */
  @Post('run')
  @HttpCode(200)
  async run(@CurrentUser() user: CurrentUserType) {
    try {
      return await this.cloud.run(user.id);
    } catch (err: any) {
      if (err?.status === 404) throw new NotFoundException(err.message);
      if (err?.status === 409) throw new ConflictException(err.message);
      throw new BadRequestException(`同步失败：${err?.message || err}`);
    }
  }

  /** 停用同步：只清配置与游标，本地数据全部保留。 */
  @Post('disable')
  @HttpCode(200)
  disable(@CurrentUser() user: CurrentUserType) {
    return this.cloud.disable(user.id);
  }

  private fail(result: ConflictRestoreResult | ConflictDismissResult): never {
    // 调用方已确认 !result.ok；这里显式收窄，避免泛型返回值的判别属性被展开。
    const failed = result as Extract<ConflictRestoreResult, { ok: false }>;
    if (failed.reason === 'not_found') throw new NotFoundException('冲突快照不存在');
    if (failed.reason === 'already_resolved') {
      throw new ConflictException(`该快照已处理（${failed.status || '未知状态'}），不能重复操作`);
    }
    if (failed.reason === 'unsupported_entity') {
      throw new BadRequestException('该实体不支持自动恢复（流水或单例配置表），请手动处理');
    }
    throw new BadRequestException('快照内容不完整，无法恢复');
  }
}
