import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BusinessModule } from './business/business.module';
import { CollectModule } from './collect/collect.module';
import { DbModule } from './db/db.module';
import { RenderModule } from './render/render.module';
import { ResumesModule } from './resumes/resumes.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    DbModule,
    AuthModule,
    ResumesModule,
    UsersModule,
    BusinessModule,
    RenderModule,
    AiModule,
    CollectModule,
    SyncModule,
  ],
})
export class AppModule {}
