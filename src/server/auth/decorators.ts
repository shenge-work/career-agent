import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import {
  IS_PUBLIC_KEY,
  type CurrentUser as CurrentUserType,
} from '../../shared/constants';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 只从 SessionGuard 挂到 req 上的 currentUser 取值，controller 不自行解析 cookie。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserType => {
    const req = ctx.switchToHttp().getRequest();
    return req.currentUser;
  }
);
