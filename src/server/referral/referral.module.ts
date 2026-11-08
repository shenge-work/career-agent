import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';

/** 内推板块：独立模块，只依赖全局 TenantDb 与 AuthModule（会话守卫）。 */
@Module({
  imports: [AuthModule],
  controllers: [ReferralController],
  providers: [TenantDb, ReferralService],
})
export class ReferralModule {}
