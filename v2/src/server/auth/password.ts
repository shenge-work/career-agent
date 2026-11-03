import { hash, verify } from '@node-rs/argon2';

/** 默认算法即 Argon2id；参数取 OWASP 建议下限（19MiB / 2 轮 / 并行度 1）。 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}
