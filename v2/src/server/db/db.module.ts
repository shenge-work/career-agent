import { Global, Module } from '@nestjs/common';
import { DB_TOKEN } from '../../shared/constants';
import { createDatabase } from './client';
import { applyMigrations } from './migrate';

/** 全局单例：进程启动时建库 + 自动跑迁移。测试里用 overrideProvider(DB_TOKEN) 换成内存库。 */
@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: async () => {
        const { db, client } = await createDatabase(process.env.PGDATA || './pgdata');
        await applyMigrations(client);
        return db;
      },
    },
  ],
  exports: [DB_TOKEN],
})
export class DbModule {}
