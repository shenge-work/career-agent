import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { ResumesController } from './resumes.controller';
import { ResumesService } from './resumes.service';

@Module({
  imports: [AuthModule],
  controllers: [ResumesController],
  providers: [TenantDb, ResumesService],
})
export class ResumesModule {}
