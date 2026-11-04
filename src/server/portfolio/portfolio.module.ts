import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';

@Module({
  imports: [AuthModule],
  controllers: [PortfolioController],
  providers: [TenantDb, PortfolioService],
})
export class PortfolioModule {}
