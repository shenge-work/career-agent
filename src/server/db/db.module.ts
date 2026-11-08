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
        const { db, client } = await createDatabase(resolveDataDirs().pgdata);
        await applyMigrations(client);
        // 0010 的业务表触发器从会话变量读设备 id，用于给同步增量归因。
        // deviceId() 只含 [A-Za-z0-9_-]，可直接拼进 SET；失败不影响本地功能。
        try {
          await client.exec(`SET app.device_id = '${deviceId()}'`);
        } catch (err) {
          console.warn('[db] 未能设置 app.device_id，同步增量将标记为 local：', err);
        }
        return db;
      },
    },
  ],
  exports: [DB_TOKEN],
})
export class DbModule {}
