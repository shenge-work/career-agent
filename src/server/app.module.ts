import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { AiModule } from './ai/ai.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuthModule } from './auth/auth.module';
import { BusinessModule } from './business/business.module';
import { CollectModule } from './collect/collect.module';
import { DbModule } from './db/db.module';
import { InterviewModule } from './interview/interview.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { ReferralModule } from './referral/referral.module';
import { RenderModule } from './render/render.module';
import { ResumesModule } from './resumes/resumes.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    DbModule,
    AuthModule,
    AttachmentsModule,
    ResumesModule,
    UsersModule,
    BusinessModule,
    RenderModule,
    AiModule,
    AgentModule,
    CollectModule,
    PortfolioModule,
    InterviewModule,
    ReferralModule,
    SyncModule,
  ],
})
export class AppModule {}
