/**
 * 腾讯云 CloudBase 云函数入口（HTTP 访问服务 / SCF，Node 18+）。
 *
 * 这里只做一件事：把 @cloudbase/node-sdk 包装成 CloudBaseSyncStore 依赖的最小接口，
 * 剩下的路由、授权、CAS、加密封包校验全部复用 cloud/sync-worker/src/handler.ts。
 * 换句话说：Cloudflare 与腾讯云跑的是同一套 /v1 哑云协议，只是运行时和存储不同。
 *
 * SDK 版本差异**只在这个文件里收敛**：
 *   · doc().set(data) 用平铺字段，doc().update({data}) 用包装（node-sdk 事务文档口径）；
 *   · db.runTransaction 返回 { result, errMsg }，适配层解包成回调返回值；
 *   · where 用 db.command.gt()；事务内只按 _id 走 doc()，不用 where。
 * 若部署时 SDK 版本行为不同，只改这里，Store 与协议层无需改动。
 */

import cloudbase from '@cloudbase/node-sdk';
import { createCloudBaseHandler } from './app';
import {
  CloudBaseSyncStore,
  type TcbCollectionLike,
  type TcbDatabaseLike,
  type TcbQueryLike,
  type TcbStorageLike,
} from './cloudbase-store';

function wrapQuery(raw: any): TcbQueryLike {
  return {
    orderBy(field, direction) {
      raw.orderBy(field, direction);
      return wrapQuery(raw);
    },
    limit(n) {
      raw.limit(n);
      return wrapQuery(raw);
    },
    get: () => raw.get(),
  };
}

function wrapCollection(raw: any): TcbCollectionLike {
  return {
    doc: (id: string) => ({
      get: () => raw.doc(id).get(),
      set: (data: Record<string, unknown>) => raw.doc(id).set(data),
      update: (data: Record<string, unknown>) => raw.doc(id).update({ data }),
    }),
    where: (condition: Record<string, unknown>) => wrapQuery(raw.where(condition)),
  };
}

export function createTcbAdapters(app: ReturnType<typeof cloudbase.init>): {
  store: CloudBaseSyncStore;
} {
  const db = app.database();
  const tcbDb: TcbDatabaseLike = {
    collection: (name) => wrapCollection(db.collection(name)),
    runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const wrapped = await db.runTransaction(async (transaction: any) =>
        fn({ collection: (name: string) => wrapCollection(transaction.collection(name)) })
      );
      return wrapped && typeof wrapped === 'object' && 'result' in wrapped
        ? ((wrapped as { result: T }).result as T)
        : (wrapped as T);
    },
    gt: (value: string) => db.command.gt(value),
  };
  const storage: TcbStorageLike = {
    uploadFile: async ({ cloudPath, fileContent }) => {
      const res = await app.uploadFile({
        cloudPath,
        fileContent: Buffer.from(fileContent),
      });
      return { fileID: res.fileID };
    },
    downloadFile: async ({ fileID }) => {
      const res = await app.downloadFile({ fileID });
      return { fileContent: new Uint8Array(res.fileContent) };
    },
  };
  return { store: new CloudBaseSyncStore(tcbDb, storage) };
}

/** 云函数环境自带临时密钥；本地直连时才需要显式 secretId / secretKey。 */
const app = cloudbase.init({
  env: process.env.TCB_ENV_ID,
  secretId: process.env.TENCENTCLOUD_SECRETID || undefined,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY || undefined,
});

export const main = createCloudBaseHandler(createTcbAdapters(app));
