import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { BLOB_STORE, LocalBlobStore } from '../storage/blob-store';
import { resolveDataDirs } from '../storage/paths';
import { SyncController } from './sync.controller';
import { SyncCloudService } from './sync-cloud.service';

/**
 * 同步模块：0011/0012 冲突地基接口 + Sync Engine 云同步编排。
 * BLOB_STORE 与附件模块共用同一内容寻址存储（附件字节全局去重）。
 */
@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [
    TenantDb,
    SyncCloudService,
    {
      provide: BLOB_STORE,
      useFactory: () => new LocalBlobStore(resolveDataDirs().blobs),
    },
  ],
})
export class SyncModule {}
