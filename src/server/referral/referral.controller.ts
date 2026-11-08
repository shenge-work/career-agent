import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { ReferralService } from './referral.service';

/**
 * 内推信息（Referral）—— 统一的内推资源池。
 *
 * 与公司档案解耦：公司详情页通过 ?companyId= 取该公司内推信息并就地新增，
 * 内推板块则列出全部记录做统一管理。跨用户资源一律 404。
 */
@Controller('api/referrals')
@UseGuards(SessionGuard, RolesGuard)
export class ReferralController {
  constructor(@Inject(ReferralService) private readonly svc: ReferralService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query('companyId') companyId?: string) {
    return this.svc.list(user.id, companyId || undefined);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.svc.create(user.id, {
      companyId: body?.companyId,
      companyName: body?.companyName,
      payload: body?.payload ?? body,
    });
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.get(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(user.id, id, {
      companyId: body?.companyId,
      payload: body?.payload ?? body,
    });
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.svc.remove(user.id, id);
  }
}
