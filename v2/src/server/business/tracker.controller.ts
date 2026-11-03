import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BusinessService } from './business.service';

/** 投递管理：记录 + 聊天等扩展字段整体放 payload，避免频繁改 schema。 */
@Controller('api/tracker')
@UseGuards(SessionGuard, RolesGuard)
export class TrackerController {
  constructor(@Inject(BusinessService) private readonly biz: BusinessService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.biz.listTracker(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.biz.createTracker(user.id, {
      companyId: body?.companyId,
      payload: body?.payload ?? body,
    });
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.getTracker(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.biz.updateTracker(user.id, id, {
      companyId: body?.companyId,
      payload: body?.payload,
    });
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.deleteTracker(user.id, id);
  }
}
