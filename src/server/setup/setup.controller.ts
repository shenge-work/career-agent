import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { SetupService } from './setup.service';

/**
 * 公开但受两道限制：① 只监听 127.0.0.1 + 回环守卫；② 仅在 users 为空时可写。
 * 不挂 SessionGuard/RolesGuard，否则「没有账号 → 无法登录 → 无法建号」会成死锁。
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
