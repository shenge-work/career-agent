import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { handleSyncRequest } from '../cloud/sync-worker/src/handler';
import { MemorySyncStore } from '../cloud/sync-worker/src/store';
import { RemoteSyncTransport } from '../src/server/sync/remote-transport';
import {
  authVerifier,
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  normalizeAccountKey,
  openEvent,
  sealEvent,
  withAccountScope,
  type VaultKeys,
} from '../src/server/sync/crypto';
import { legacyVaultOwnedBy } from '../src/server/sync/sync-cloud.service';
import { INITIAL_SEQ, type SyncEvent } from '../src/server/sync/transport';

/**
 * I1 · 账号隔离回归：
 *   · 不同账号即使填完全相同的恢复码，也落到不同云端空间、用不同密钥；
 *   · 同一账号跨设备仍可同步（不回退）；
 *   · 存量升级前的数据不丢，但别账号的密文会被账号指纹拦下；
 *   · 云端仍是哑云：只有密文与不透明空间标识，多个账号共用一台服务也互不干扰。
 */

const BASE = 'https://sync.example.test';
const CODE = generateRecoveryCode();
const A = 'alice@local.test';
const B = 'bob@local.test';
const SHA = 'a'.repeat(64);

function fetchFor(store: MemorySyncStore): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handleSyncRequest(new Request(url, init), { store });
  }) as typeof fetch;
}

function transportFor(
  keys: VaultKeys,
  store: MemorySyncStore,
  deviceId: string
): RemoteSyncTransport {
  return new RemoteSyncTransport({ baseUrl: BASE, keys, deviceId, fetchImpl: fetchFor(store) });
}

function sampleEvent(title: string, scope?: string): SyncEvent {
  return {
    localCursor: '00000170000000000.000000',
    entity: 'resumes',
    entityId: 'res_account_scope',
    op: 'upsert',
    rowHlc: '00000170000000001.000002',
    deviceId: 'device-A',
    row: { id: 'res_account_scope', title },
    blobKeys: [],
    ...(scope ? { scope } : {}),
  };
}

function seal(keys: ReturnType<typeof deriveVaultKeys>, title: string, deviceId = 'device-A') {
  return sealEvent(keys, sampleEvent(title, keys.accountScope), {
    deviceId,
    batchId: 'batch-account-isolation',
    index: 0,
  });
}

describe('账号绑定密钥派生', () => {
  it('v1（不传账号因子）字节级保持不变 —— 存量 sync_state 与历史数据零影响', () => {
    const v1 = deriveVaultKeys(CODE);
    expect(v1.keyVersion).toBe(1);
    expect(deriveVaultKeys(CODE).vaultId).toBe(v1.vaultId);
    expect(deriveVaultKeys(CODE, v1.salt).vaultId).toBe(v1.vaultId);
    expect(v1.accountScope).toBeUndefined();
    // 账号绑定派生必须落在另一个空间
    expect(deriveVaultKeys(CODE, undefined, A).vaultId).not.toBe(v1.vaultId);
  });

  it('不同账号 + 完全相同的恢复码 → vaultId / 授权哈希 / 三种密钥 / blob key 全部不同', () => {
    const ka = deriveVaultKeys(CODE, undefined, A);
    const kb = deriveVaultKeys(CODE, undefined, B);
    expect(ka.keyVersion).toBe(2);
    expect(kb.keyVersion).toBe(2);
    expect(ka.vaultId).not.toBe(kb.vaultId);
    expect(authVerifier(ka)).not.toBe(authVerifier(kb));
    expect(ka.encKey.equals(kb.encKey)).toBe(false);
    expect(ka.macKey.equals(kb.macKey)).toBe(false);
    expect(ka.authKey.equals(kb.authKey)).toBe(false);
    expect(blobObjectKey(ka, SHA)).not.toBe(blobObjectKey(kb, SHA));
    expect(blobObjectKey(withAccountScope(ka, A), SHA)).not.toBe(
      blobObjectKey(withAccountScope(kb, B), SHA)
    );
  });

  it('同一账号 + 同一恢复码（跨设备）→ 派生完全一致，且账号因子大小写/空格不敏感', () => {
    const a1 = deriveVaultKeys(CODE, undefined, A);
    const a2 = deriveVaultKeys(CODE, undefined, '  ALICE@Local.Test  ');
    expect(a2.vaultId).toBe(a1.vaultId);
    expect(a2.encKey.equals(a1.encKey)).toBe(true);
    expect(normalizeAccountKey('  ALICE@Local.Test  ')).toBe(A);
  });

  it('账号隔离指纹稳定、跨账号不同，且不含任何账号明文', () => {
    const ka = withAccountScope(deriveVaultKeys(CODE, undefined, A), A);
    const kb = withAccountScope(deriveVaultKeys(CODE, undefined, B), B);
    expect(ka.accountScope).toMatch(/^[0-9a-f]{32}$/);
    expect(withAccountScope(ka, A).accountScope).toBe(ka.accountScope);
    expect(ka.accountScope).not.toBe(kb.accountScope);
    expect(ka.accountScope).not.toContain('alice');
    expect(ka.accountScope).not.toContain(A);
  });

  it('只依赖 encKey 与账号因子：从存量 keysJson 恢复后仍能重算同一指纹', () => {
    // 模拟 run()：只有落库的派生密钥，没有恢复码。
    const stored = deriveVaultKeys(CODE);
    const fromStored = withAccountScope(stored, A);
    const freshlyDerived = withAccountScope(deriveVaultKeys(CODE), A);
    expect(fromStored.accountScope).toBe(freshlyDerived.accountScope);
    expect(withAccountScope(stored, B).accountScope).not.toBe(fromStored.accountScope);
  });
});

describe('封包级账号隔离', () => {
  it('同一套存量密钥下，别账号的封包被 AAD 账号指纹拦下', () => {
    const v1 = deriveVaultKeys(CODE); // 存量 vault 的密钥与账号解耦
    const keysA = withAccountScope(v1, A);
    const keysB = withAccountScope(v1, B);
    const env = seal(keysA, 'A 的历史数据');
    expect(() => openEvent(keysB, env)).toThrow(/账号隔离指纹不匹配/);
    expect(openEvent(keysA, env).event.row?.title).toBe('A 的历史数据');
  });

  it('存量升级前的事件（无指纹）仍能被本账号读取 —— 历史数据不丢', () => {
    const v1 = deriveVaultKeys(CODE);
    const keysA = withAccountScope(v1, A);
    const legacyEnv = sealEvent(v1, sampleEvent('升级前的历史数据'), {
      deviceId: 'device-A',
      batchId: 'batch-legacy',
      index: 0,
    });
    expect(openEvent(keysA, legacyEnv).event.row?.title).toBe('升级前的历史数据');
  });

  it('存量 vault 归属判定：本账号放行、别账号拒绝、未认领空间允许首个账号认领', () => {
    const v1 = deriveVaultKeys(CODE);
    const keysA = withAccountScope(v1, A);
    const keysB = withAccountScope(v1, B);
    const claimed = seal(keysA, 'A 的认领标记');
    const legacyOnly = sealEvent(v1, sampleEvent('很老的数据'), {
      deviceId: 'device-A',
      batchId: 'batch-old',
      index: 0,
    });
    expect(legacyVaultOwnedBy([claimed], keysA.accountScope)).toBe(true);
    expect(legacyVaultOwnedBy([claimed], keysB.accountScope)).toBe(false);
    expect(legacyVaultOwnedBy([legacyOnly, claimed], keysA.accountScope)).toBe(true);
    expect(legacyVaultOwnedBy([legacyOnly, claimed], keysB.accountScope)).toBe(false);
    expect(legacyVaultOwnedBy([legacyOnly], keysA.accountScope)).toBe(true);
    expect(legacyVaultOwnedBy([], keysA.accountScope)).toBe(true);
    expect(legacyVaultOwnedBy([{ aad: 'not-json' }], keysA.accountScope)).toBe(false);
    expect(legacyVaultOwnedBy([claimed], undefined)).toBe(false);
  });

  it('v2 空间下，别账号的封包连 vaultId 这一关都过不去', () => {
    const keysA = withAccountScope(deriveVaultKeys(CODE, undefined, A), A);
    const keysB = withAccountScope(deriveVaultKeys(CODE, undefined, B), B);
    const env = seal(keysA, 'A 的私有简历');
    expect(() => openEvent(keysB, env)).toThrow(/vaultId/);
  });
});

describe('共用同一云端服务时的端到端隔离', () => {
  it('两个账号填同一恢复码：各建各的空间，B 拉不到 A 的任何事件', async () => {
    const store = new MemorySyncStore(); // 一个 store = 多个账号共用同一台云端服务
    const keysA = withAccountScope(deriveVaultKeys(CODE, undefined, A), A);
    const keysB = withAccountScope(deriveVaultKeys(CODE, undefined, B), B);
    const tA = transportFor(keysA, store, 'device-A');
    const tB = transportFor(keysB, store, 'device-B');

    expect(await tA.setupVault()).toBe('created');
    expect(await tB.setupVault()).toBe('created'); // 不同 vaultId，不会 vault_exists
    expect(tA.vaultId).not.toBe(tB.vaultId);

    const head = await tA.head();
    await tA.push([seal(keysA, 'A 的私有简历')], head.seq);

    const pulledByB = await tB.pull(INITIAL_SEQ);
    expect(pulledByB.envelopes).toHaveLength(0);

    const pulledByA = await tA.pull(INITIAL_SEQ);
    expect(pulledByA.envelopes).toHaveLength(1);
    expect(openEvent(keysA, pulledByA.envelopes[0]).event.row?.title).toBe('A 的私有简历');
  });

  it('同一账号在另一台设备接入：joined 且能读到全部已有事件（跨设备同步不回退）', async () => {
    const store = new MemorySyncStore();
    const keysA = withAccountScope(deriveVaultKeys(CODE, undefined, A), A);
    const device1 = transportFor(keysA, store, 'device-A');
    expect(await device1.setupVault()).toBe('created');
    const head = await device1.head();
    await device1.push([seal(keysA, '设备 1 的简历')], head.seq);

    const device2 = transportFor(keysA, store, 'device-B');
    expect(await device2.setupVault()).toBe('joined');
    const pulled = await device2.pull(INITIAL_SEQ);
    expect(pulled.envelopes).toHaveLength(1);
    expect(openEvent(keysA, pulled.envelopes[0]).event.row?.title).toBe('设备 1 的简历');
  });

  it('云端只见密文与不透明空间标识：落库内容不含账号、邮箱或业务明文', async () => {
    const store = new MemorySyncStore();
    const keysA = withAccountScope(deriveVaultKeys(CODE, undefined, A), A);
    const tA = transportFor(keysA, store, 'device-A');
    await tA.setupVault();
    const head = await tA.head();
    await tA.push([seal(keysA, '绝密的简历标题')], head.seq);

    // 从「云端视角」把落库的封包原样拉回来检查：AAD 是明文路由信息，其余全是密文。
    const pulled = await tA.pull(INITIAL_SEQ);
    expect(pulled.envelopes).toHaveLength(1);
    const envelope = pulled.envelopes[0];
    const aad = JSON.parse(envelope.aad);
    expect(envelope.vaultId).toBe(keysA.vaultId);
    expect(aad.accountScope).toBe(keysA.accountScope);
    expect(Object.keys(aad).sort()).toEqual(
      ['accountScope', 'batchId', 'createdAt', 'deviceId', 'index', 'v', 'vaultId'].sort()
    );
    expect(envelope.aad).not.toContain(A);
    expect(envelope.aad).not.toContain('alice');
    expect(envelope.aad).not.toContain('绝密的简历标题');
    expect(envelope.ciphertext).not.toContain('绝密的简历标题');
    // 云端零身份：不透明指纹里不含任何账号明文。
    expect(aad.accountScope).toMatch(/^[0-9a-f]{32}$/);
    expect(aad.accountScope).not.toContain('alice');
  });
});
