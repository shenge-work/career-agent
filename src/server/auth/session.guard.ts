import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../shared/constants';
import { SessionsService } from './sessions.service';
import { hashToken, readSessionCookie } from './tokens';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionsService) private readonly sessions: SessionsService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = readSessionCookie(req.headers?.cookie);
    if (!token) throw new UnauthorizedException('未登录');

    const tokenHash = hashToken(token);
    const user = await this.sessions.resolveUser(tokenHash);
    if (!user) throw new UnauthorizedException('会话无效或已过期');

    req.currentUser = user;
    req.sessionTokenHash = tokenHash;
    return true;
  }
}
