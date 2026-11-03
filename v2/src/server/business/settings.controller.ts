import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BusinessService } from './business.service';

/** 每账号一行设置；PUT 为 jsonb 合并，只覆盖传入的键。 */
@Controller('api/settings')
@UseGuards(SessionGuard, RolesGuard)
export class SettingsController {
  constructor(@Inject(BusinessService) private readonly biz: BusinessService) {}

  @Get()
  get(@CurrentUser() user: CurrentUserType) {
    return this.biz.getSettings(user.id);
  }

  @Put()
  update(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.biz.mergeSettings(user.id, body);
  }
}
