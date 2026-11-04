import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [AuthModule, AiModule],
  controllers: [AgentController],
  providers: [TenantDb, AgentService],
})
export class AgentModule {}
