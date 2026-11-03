import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottle } from './login-throttle.service';
import { RolesGuard } from './roles.guard';
import { SessionGuard } from './session.guard';
import { SessionsService } from './sessions.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionsService, LoginThrottle, SessionGuard, RolesGuard],
  exports: [SessionsService, SessionGuard, RolesGuard],
})
export class AuthModule {}
