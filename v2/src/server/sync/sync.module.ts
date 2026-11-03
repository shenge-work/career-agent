import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { SYNC_HTTP, defaultFeishuHttp } from './feishu-client';
import { RegisterSessionStore } from './register-session.store';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

/**
 * P2b 第二期 · 飞书同步模块。
 *
 * SYNC_HTTP 可注入：默认走 global fetch（真飞书），测试 overrideProvider 注入桩，
 * 即可离线覆盖「凭证校验 / 上报 / 版本恢复 / OAuth / Device Flow」全链路，
 * 不需要真实凭证、绝不打外网。
 */
@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [TenantDb, RegisterSessionStore, SyncService, { provide: SYNC_HTTP, useValue: defaultFeishuHttp }],
  exports: [SyncService],
})
export class SyncModule {}
