import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { SnippetController } from './snippet.controller';
import { SnippetService } from './snippet.service';

/** STAR 经历素材库：独立模块，只依赖全局 TenantDb 与 AuthModule（会话守卫）。 */
@Module({
  imports: [AuthModule],
  controllers: [SnippetController],
  providers: [TenantDb, SnippetService],
})
export class SnippetModule {}
