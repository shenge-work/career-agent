import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { registerAttachmentMultipart } from './attachments/multipart';
import { resolveDataDirs } from './storage/paths';
import { assertLocalRequest } from './security';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false })
  );

  // Fastify 插件必须在 listen 之前注册；e2e 测试走同一函数，避免两条启动路径行为分叉。
  await registerAttachmentMultipart(app);

  // 本地回环守卫：防 DNS rebinding / 跨站 CSRF。测试走 app.inject()，不经过此 hook。
  app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
    const check = assertLocalRequest(request.headers as Record<string, unknown>, request.method);
    if (!check.ok) {
      reply.code(403).send({ statusCode: 403, message: check.reason, error: 'Forbidden' });
      return;
    }
    done();
  });

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '127.0.0.1');
  console.log(`CareerAgent API → http://127.0.0.1:${port}/api`);
  console.log(`数据目录: ${resolveDataDirs().root}（pgdata + blobs）`);
}

bootstrap().catch((e) => {
  console.error('[启动失败]', e);
  process.exit(1);
});
