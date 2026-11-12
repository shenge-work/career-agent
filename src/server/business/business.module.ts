import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RenderModule } from '../render/render.module';
import { TenantDb } from '../tenant/tenant-db';
import { BusinessService } from './business.service';
import { ApplicationsController } from './applications.controller';
import { CompaniesController } from './companies.controller';
import { JdController } from './jd.controller';
import { SettingsController } from './settings.controller';
import { ThemeController } from './theme.controller';
import { TrackerController } from './tracker.controller';
import { VersionsController } from './versions.controller';

@Module({
  imports: [AuthModule, RenderModule],
  controllers: [
    ApplicationsController,
    CompaniesController,
    JdController,
    ThemeController,
    TrackerController,
    VersionsController,
    SettingsController,
  ],
  providers: [TenantDb, BusinessService],
})
export class BusinessModule {}
