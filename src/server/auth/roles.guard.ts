import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * 兼容占位守卫（恒放行）。
 *
 * 账号体系去角色化后，鉴权只由 SessionGuard 负责：登录即可访问自己的全部数据，
 * 不存在任何基于角色/管理员的权限分支。保留类名与注入点，是为了让既有控制器的
 * `@UseGuards(SessionGuard, RolesGuard)` 无需逐个改动，同时保证「任何产品行为
 * 都不再读取或依赖角色取值」。请勿在此重新加入权限判断。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}
