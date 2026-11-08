/** 云函数处理器工厂：不 import 任何腾讯云 SDK，便于本地用内存替身跑完整链路。 */

import { handleSyncRequest } from '../../sync-worker/src/handler';
import type { SyncStore } from '../../sync-worker/src/store';
import {
  toCloudBaseHttpResponse,
  toWebRequest,
  type CloudBaseHttpEvent,
  type CloudBaseHttpResponse,
} from './gateway';

export interface CloudBaseHandlerOptions {
  store: SyncStore;
  /** 测试注入固定时间；生产用 new Date()。 */
  now?: () => string;
  origin?: string;
}

export type CloudBaseHandler = (
  event: CloudBaseHttpEvent,
  context?: unknown
) => Promise<CloudBaseHttpResponse>;

export function createCloudBaseHandler(options: CloudBaseHandlerOptions): CloudBaseHandler {
  return async (event) => {
    const request = toWebRequest(event, options.origin);
    const response = await handleSyncRequest(request, {
      store: options.store,
      now: options.now,
    });
    return toCloudBaseHttpResponse(response);
  };
}
