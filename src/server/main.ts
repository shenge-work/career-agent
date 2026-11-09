import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { registerAttachmentMultipart } from './attachments/multipart';
import { resolveDataDirs } from './storage/paths';
import { assertLocalRequest } from './security';

/**
 * 构建 Nest/Fastify 应用，但不监听端口。
 *
 * `npm start` 与桌面客户端的内嵌服务共用这一条启动路径：桌面版拿到 app 后
 * 会追加静态资源路由，再自行 listen 到系统分配的回环端口。拆开 create / listen
 * 是为了避免两条启动路径在插件注册、回环守卫上出现行为分叉。
 */
export async function createServerApp(): Promise<NestFastifyApplication> {
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

  return app;
}

/** CLI 入口：固定/环境变量指定端口，监听 127.0.0.1。 */
export async function bootstrap(): Promise<NestFastifyApplication> {
  const app = await createServerApp();
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '127.0.0.1');
  console.log(`CareerAgent API → http://127.0.0.1:${port}/api`);
  console.log(`数据目录: ${resolveDataDirs().root}（pgdata + blobs）`);
  return app;
}

// 被桌面端 require 时不能自动启动；只有作为 CLI 直接执行时才 bootstrap。
if (require.main === module) {
  bootstrap().catch((e) => {
    console.error('[启动失败]', e);
    process.exit(1);
  });
}
