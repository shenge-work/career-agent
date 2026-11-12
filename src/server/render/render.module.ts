import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ResumesService } from '../resumes/resumes.service';
import { TenantDb } from '../tenant/tenant-db';
import { RenderController } from './render.controller';
import { PdfService } from './pdf.service';
import { ImagePdfService } from './image-pdf.service';

@Module({
  imports: [AuthModule],
  controllers: [RenderController],
  providers: [TenantDb, ResumesService, PdfService, ImagePdfService],
  exports: [PdfService],
})
export class RenderModule {}
