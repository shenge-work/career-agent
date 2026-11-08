/** Cloudflare Worker 入口：把 D1 / R2 绑定适配成 SyncStore，其余逻辑全在 handler.ts。 */
import { handleSyncRequest } from './handler';
import { D1R2Store, type D1Like, type R2Like } from './store';

export interface SyncWorkerBindings {
  DB: D1Like;
  BLOBS: R2Like;
}

export default {
  async fetch(request: Request, env: SyncWorkerBindings): Promise<Response> {
    return handleSyncRequest(request, { store: new D1R2Store(env.DB, env.BLOBS) });
  },
};
