import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser, Public } from './decorators';
import { AuthService } from './auth.service';
import { RolesGuard } from './roles.guard';
import { SessionGuard } from './session.guard';
import { SessionsService } from './sessions.service';
import { clearSessionCookie, sessionCookie } from './tokens';

@Controller('api/auth')
@UseGuards(SessionGuard, RolesGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionsService) private readonly sessions: SessionsService
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: any,
    @Req() req: any,
    @Res({ passthrough: true }) reply: any
  ): Promise<{ user: CurrentUserType }> {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) throw new BadRequestException('邮箱与密码必填');

    const meta = {
      userAgent: String(req.headers?.['user-agent'] || ''),
      ip: String(req.ip || ''),
    };
    const r = await this.auth.login(email, password, meta);
    reply.header('Set-Cookie', sessionCookie(r.token, process.env.COOKIE_SECURE === 'true'));
    return { user: r.user };
  }

  @Public()
  @Post('dev-login')
  @HttpCode(200)
  async devLogin(
    @Res({ passthrough: true }) reply: any
  ): Promise<{ user: CurrentUserType }> {
    const r = await this.auth.devLogin();
    reply.header('Set-Cookie', sessionCookie(r.token, process.env.COOKIE_SECURE === 'true'));
    return { user: r.user };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: any,
    @Res({ passthrough: true }) reply: any
  ): Promise<{ ok: boolean }> {
    if (req.sessionTokenHash) await this.sessions.revoke(req.sessionTokenHash);
    reply.header('Set-Cookie', clearSessionCookie(process.env.COOKIE_SECURE === 'true'));
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: CurrentUserType): { user: CurrentUserType } {
    return { user };
  }
}
