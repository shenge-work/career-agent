import {
  BadRequestException,
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

/**
 * 0011/0012 冲突地基的本地窗口（不是云端同步接口）。
 *
 * 云端账号 / Sync Engine 还没做，但本地已经能：看到哪些跨设备编辑被 LWW 落下、
 * 查落败方原文、把某一版恢复成当前版本、把不需要的快照标记忽略，以及查看
 * BOSS 聊天被投影成的不可变事件。恢复动作是普通本地写，会领新 HLC 并写 change_log，
 * 将来云端上线后同样能被增量拉走。
 *
 * 全部经 SessionGuard + TenantDb.forUser，跨用户数据一律 404。
 */
@Controller('api/sync')
@UseGuards(SessionGuard, RolesGuard)
export class SyncController {
  constructor(@Inject(TenantDb) private readonly tenant: TenantDb) {}

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
