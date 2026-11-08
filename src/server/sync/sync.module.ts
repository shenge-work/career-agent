import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { SyncController } from './sync.controller';

/**
 * 本地冲突地基接口：审计 + 人工恢复 / 忽略；回灌辅助函数（sync-import.ts）
 * 与恢复列映射（restore.ts）由未来 Sync Engine 直接复用。
 */
@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [TenantDb],
})
export class SyncModule {}
