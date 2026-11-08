import { Global, Module } from '@nestjs/common';
import { DB_TOKEN } from '../../shared/constants';
import { createDatabase } from './client';
import { applyMigrations } from './migrate';
import { resolveDataDirs } from '../storage/paths';
import { deviceId } from '../sync/device';

/** 全局单例：进程启动时建库 + 自动跑迁移。测试里用 overrideProvider(DB_TOKEN) 换成内存库。 */
@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: async () => {
        const { db, client, close } = await createDatabase(resolveDataDirs().pgdata);
        await applyMigrations(client);
        // 0010 的业务表触发器从会话变量读设备 id，用于给同步增量归因。
        // deviceId() 只含 [A-Za-z0-9_-]，可直接拼进 SET；失败不影响本地功能。
        try {
          await client.exec(`SET app.device_id = '${deviceId()}'`);
        } catch (err) {
          console.warn('[db] 未能设置 app.device_id，同步增量将标记为 local：', err);
        }

        // 优雅关闭：PGlite 是进程内 WASM 版 PG，收到 SIGTERM 直接退出会把 WAL 留在
        // 半写状态，下次启动直接 PANIC「could not locate a valid checkpoint record」，
        // 整个库只能回退备份（本项目已因此踩过两次）。这里必须自己接管信号。
        let closing = false;
        const shutdown = async (signal: string) => {
          if (closing) return;
          closing = true;
          try {
            await close();
            console.log(`[db] 已在 ${signal} 时关闭数据库`);
          } catch (err) {
            console.warn('[db] 关闭数据库失败：', err);
          }
          process.exit(0);
        };
        process.once('SIGINT', () => void shutdown('SIGINT'));
        process.once('SIGTERM', () => void shutdown('SIGTERM'));

        return db;
      },
    },
  ],
  exports: [DB_TOKEN],
})
export class DbModule {}
