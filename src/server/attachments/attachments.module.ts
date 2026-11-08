import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { BLOB_STORE, LocalBlobStore } from '../storage/blob-store';
import { resolveDataDirs } from '../storage/paths';
import { AttachmentService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';

/**
 * BLOB_STORE 是唯一可替换点：将来接云端托管时把 useFactory 换成
 * RemoteBlobStore（或一个 Local + Remote 的复合实现），业务代码零改动。
 */
@Module({
  imports: [AuthModule],
  controllers: [AttachmentsController],
  providers: [
    TenantDb,
    AttachmentService,
    {
      provide: BLOB_STORE,
      useFactory: () => new LocalBlobStore(resolveDataDirs().blobs),
    },
  ],
})
export class AttachmentsModule {}
