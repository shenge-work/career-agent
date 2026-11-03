import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { assertLocalRequest } from './security';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false })
  );

  // 本地回环守卫：防 DNS rebinding / 跨站 CSRF。测试走 app.inject()，不经过此 hook。
  // 飞书 OAuth 回调（/api/feishu/oauth/callback）是浏览器从飞书域 302 跨站抵达的，
  // 在守卫里按前缀放行（Host 仍必须回环），见 security.ts 的 CROSS_SITE_ALLOWED_PREFIXES。
  app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
    const check = assertLocalRequest(
      request.headers as Record<string, unknown>,
      request.method,
      request.url
    );
    if (!check.ok) {
      reply.code(403).send({ statusCode: 403, message: check.reason, error: 'Forbidden' });
      return;
    }
    done();
  });

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '127.0.0.1');
  console.log(`Resume Studio API → http://127.0.0.1:${port}/api`);
  console.log(`数据目录: ${process.env.PGDATA || './pgdata'}（PGlite / PostgreSQL 兼容）`);
}

bootstrap().catch((e) => {
  console.error('[启动失败]', e);
  process.exit(1);
});
