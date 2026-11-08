import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDirs } from '../storage/paths';

/**
 * 本机稳定设备 id：同一个安装包多次启动不变，不同设备不同。
 * 与 hlc 一起写进 attachments / change_log，用于冲突归因与增量回放。
 * 测试可用 CAREER_AGENT_DEVICE_ID 覆盖，避免写真实数据目录。
 */
let cached: string | null = null;

export function deviceId(): string {
  if (cached) return cached;

  const fromEnv = process.env.CAREER_AGENT_DEVICE_ID;
  if (fromEnv && /^[A-Za-z0-9_-]{1,64}$/.test(fromEnv)) {
    cached = fromEnv;
    return cached;
  }

  const file = path.join(resolveDataDirs().root, 'device.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed?.deviceId === 'string' && parsed.deviceId) {
      cached = parsed.deviceId;
      return cached;
    }
  } catch {
    // 首次启动 / 文件损坏：生成新的
  }

  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ deviceId: id }) + '\n', { mode: 0o600 });
  } catch {
    // 只读环境（例如打包异常）仍可用进程内 id，只是重启后会变
  }
  cached = id;
  return cached;
}
