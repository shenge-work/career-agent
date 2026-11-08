import { fastifyMultipart } from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MAX_BLOB_BYTES } from '../storage/blob-store';

/**
 * multipart 插件注册（main.ts 与 e2e 测试共用，保证两条启动路径行为一致）。
 *
 * 版本约束：@nestjs/platform-fastify@12 的 peerOptional 要求 @fastify/multipart@^10.1.0，
 * v9 会在 npm install 阶段被 ERESOLVE 拒绝。
 * 限制放在插件层（files/parts/fileSize）+ BlobStore 层（字节计量）双保险，
 * throwFileSizeLimit=true 让超限在 req.file() 阶段就抛错，而不是静默截断。
 */
export async function registerAttachmentMultipart(app: NestFastifyApplication): Promise<void> {
  // 仓库里存在两份 fastify（根 5.12.8 / @nestjs/platform-fastify 内嵌 5.12.7），
  // 两者的 FastifyInstance 类型互不兼容，但插件是 fastify-plugin 包装、运行时与版本无关。
  // 这里只做类型断言；e2e 上传用例会验证实际注册成功。
  await app.register(fastifyMultipart as any, {
    limits: { fileSize: MAX_BLOB_BYTES, files: 1, fields: 8, parts: 12 },
    throwFileSizeLimit: true,
  });
}
