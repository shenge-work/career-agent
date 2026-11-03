import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from '../../shared/constants';
import { CurrentUser } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { ResumesService } from './resumes.service';

@Controller('api/resumes')
@UseGuards(SessionGuard, RolesGuard)
export class ResumesController {
  constructor(@Inject(ResumesService) private readonly resumes: ResumesService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.resumes.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserType, @Body() body: any) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) throw new BadRequestException('title 必填');
    return this.resumes.create(user.id, {
      title,
      payload: body?.payload && typeof body.payload === 'object' ? body.payload : { sections: [] },
      kind: body?.kind,
      parentId: body?.parentId,
      jobId: body?.jobId,
      jdText: body?.jdText,
      tags: Array.isArray(body?.tags) ? body.tags : [],
      isMaster: !!body?.isMaster,
    });
  }

  @Post(':id/master')
  setMaster(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.resumes.setMaster(user.id, id);
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.resumes.get(user.id, id);
  }

  @Put(':id')
  update(@CurrentUser() user: CurrentUserType, @Param('id') id: string, @Body() body: any) {
    return this.resumes.update(user.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.resumes.remove(user.id, id);
  }
}
