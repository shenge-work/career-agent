import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BusinessService } from './business.service';

/** 公司档案 + 岗位 JD。所有查询都经 BusinessService → TenantDb.forUser。 */
@Controller('api/companies')
@UseGuards(SessionGuard, RolesGuard)
export class CompaniesController {
  constructor(@Inject(BusinessService) private readonly biz: BusinessService) {}

  // 子资源先注册，避免与 :id 单条路由混淆
  @Get(':id/jds')
  listJds(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.listCompanyJds(user.id, id);
  }

  @Post(':id/jds')
  createJd(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.biz.createCompanyJd(user.id, id, { payload: body?.payload ?? body });
  }

  @Delete(':id/jds/:jdId')
  deleteJd(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Param('jdId') jdId: string
  ) {
    return this.biz.deleteCompanyJd(user.id, id, jdId);
  }

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.biz.listCompanies(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    return this.biz.createCompany(user.id, { name: body?.name, payload: body?.payload ?? body });
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.getCompany(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.biz.updateCompany(user.id, id, { name: body?.name, payload: body?.payload });
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.biz.deleteCompany(user.id, id);
  }
}
