import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { BusinessService } from './business.service';

/** 主题模板：列出内置主题 + 对某份简历一键应用主题。 */
@Controller('api')
@UseGuards(SessionGuard, RolesGuard)
export class ThemeController {
  constructor(@Inject(BusinessService) private readonly biz: BusinessService) {}

  @Get('themes')
  list() {
    return this.biz.listThemes();
  }

  @Post('resumes/:id/theme')
  apply(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() body: any
  ) {
    return this.biz.applyTheme(user.id, id, String(body?.themeId || body?.theme || 'classic'));
  }
}
