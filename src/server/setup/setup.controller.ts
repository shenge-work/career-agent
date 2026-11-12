import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { SetupService } from './setup.service';

/**
 * 公开但受回环 Host/Origin 守卫（main.ts）保护。
 * 不挂 SessionGuard（否则「没有账号 → 无法登录 → 无法建号」会成死锁）。
 * 账号一律平等：bootstrap 创建的是普通独立账号，不是管理员，且允许持续创建。
 */
@Controller('api/setup')
export class SetupController {
  constructor(@Inject(SetupService) private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  async status(): Promise<{ needsSetup: boolean }> {
    return { needsSetup: await this.setup.needsSetup() };
  }

  @Public()
  @Post('bootstrap')
  @HttpCode(201)
  bootstrap(@Body() body: any) {
    return this.setup.bootstrap({
      email: String(body?.email || ''),
      password: String(body?.password || ''),
      displayName: body?.displayName ? String(body.displayName) : null,
    });
  }
}
