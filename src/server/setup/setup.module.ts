import { Module } from '@nestjs/common';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

/** DB_TOKEN 由 @Global 的 DbModule 提供，这里无需再 import。 */
@Module({
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
