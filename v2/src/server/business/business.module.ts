import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantDb } from '../tenant/tenant-db';
import { BusinessService } from './business.service';
import { CompaniesController } from './companies.controller';
import { SettingsController } from './settings.controller';
import { TrackerController } from './tracker.controller';
import { VersionsController } from './versions.controller';

@Module({
  imports: [AuthModule],
  controllers: [CompaniesController, TrackerController, VersionsController, SettingsController],
  providers: [TenantDb, BusinessService],
})
export class BusinessModule {}
