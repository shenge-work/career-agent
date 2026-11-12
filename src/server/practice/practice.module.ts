import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { PracticeController } from './practice.controller';
import { PracticeService } from './practice.service';

/**
 * N14 · AI 面试练习模块。
 * 只 import AuthModule（守卫 / 会话）与 AiModule（AiService），
 * 复用 TenantDb 行级隔离，不扩展 InterviewModule / AgentModule。
 */
@Module({
  imports: [AuthModule, AiModule],
  controllers: [PracticeController],
  providers: [TenantDb, PracticeService],
})
export class PracticeModule {}
