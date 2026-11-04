import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { InterviewController } from './interview.controller';
import { InterviewService } from './interview.service';

@Module({
  imports: [AuthModule],
  controllers: [InterviewController],
  providers: [TenantDb, InterviewService],
})
export class InterviewModule {}
