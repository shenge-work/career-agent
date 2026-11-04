import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { CollectController } from './collect.controller';
import { CollectService } from './collect.service';

@Module({
  imports: [AuthModule],
  controllers: [CollectController],
  providers: [TenantDb, CollectService],
  exports: [CollectService],
})
export class CollectModule {}
