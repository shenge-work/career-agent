import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  disableSync,
  enableSync,
  fmtTime,
  getSyncStatus,
  runSync,
  type SyncEnableResult,
  type SyncRunStats,
} from '../api';

/**
 * 云同步（#/sync）：哑云 + E2EE + local-first。
 *
 * 本页三件事：
 *   1. 启用 —— 输入/生成恢复码；为当前账号创建或接入账号级同步空间（按账号隔离）；
 *   2. 状态与手动同步 —— 游标、最近结果、立即推拉一轮；
 *   3. 停用 —— 只清配置，本地数据全部保留（断云不降级）。
 *
 * 恢复码只显示一次（服务端只存派生密钥，无法找回）；另一台设备需先登录同一账号，
 * 再手抄这串码接入。不同账号即使使用相同恢复码也落到不同空间、用不同密钥。
 */

/** 8 组 × 8 位 hex：与 crypto.generateRecoveryCode 同格式，客户端本地生成。 */
function generateRecoveryCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (hex.match(/.{8}/g) || []).join('-');
}

function formatStats(s: SyncRunStats): string {
  const parts = [
    `推送 ${s.pushed} 条${s.baseline ? '（含基线全量）' : ''}`,
    `拉取 ${s.pulled} 条（落库 ${s.applied}）`,
  ];
  if (s.rejected) parts.push(`冲突留底 ${s.rejected} 条`);
  if (s.skipped) parts.push(`跳过 ${s.skipped} 条`);
  if (s.blobsUploaded) parts.push(`附件上云 ${s.blobsUploaded} 个`);
  if (s.blobsDownloaded) parts.push(`附件下载 ${s.blobsDownloaded} 个`);
  if (s.localBlobsGc) parts.push(`本地清理 ${s.localBlobsGc} 个`);
  if (s.cloudBlobsGc) parts.push(`云端清理 ${s.cloudBlobsGc} 个`);
  return parts.join(' · ');
}

export default function Sync() {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [setupResult, setSetupResult] = useState<SyncEnableResult | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const { data: status, isLoading } = useQuery({
    queryKey: ['sync-status'],
    queryFn: getSyncStatus,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
  };

  const enableM = useMutation({
    mutationFn: () => enableSync(code.trim()),
    onSuccess: (r) => {
      setSetupResult(r);
      setCode('');
      setError('');
      setNote(
        r.mode === 'created'
          ? '已创建同步保险库并完成基线全量首传。请立即抄写下方的恢复码。'
          : '已加入现有保险库并完成首次同步。两台设备的数据已按 LWW 合并。'
      );
      invalidate();
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  const runM = useMutation({
    mutationFn: runSync,
    onSuccess: (stats) => {
      setError('');
      setNote(`同步完成：${formatStats(stats)}`);
      invalidate();
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  const disableM = useMutation({
    mutationFn: disableSync,
    onSuccess: () => {
      setConfirmDisable(false);
      setSetupResult(null);
      setError('');
      setNote('已停用云同步。本地数据全部保留；重新启用需再次输入恢复码。');
      invalidate();
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  async function copyCode(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      setError('复制失败，请手动选中复制');
    }
  }

  const statusLabel = useMemo(() => {
    switch (status?.status) {
      case 'syncing':
        return '同步中';
      case 'error':
        return '出错';
      case 'disabled':
        return '已停用';
      default:
        return '空闲';
    }
  }, [status?.status]);

  return (
    <>
      <div className="page-head">
        <h1>云同步</h1>
        <p className="muted small">
          这是<strong>当前账号</strong>的跨设备同步空间：每个账号的云端数据相互独立、互不干扰。
          本地永远完整可用，云端只是可选的备份与跨设备通道（断网不降级）。
          端到端加密：云端只见密文与不透明空间标识，密钥由恢复码与账号共同派生、永不离开本机。
        </p>
      </div>

      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      {isLoading ? (
        <div className="empty">正在读取同步状态…</div>
      ) : !status?.enabled ? (
        /* ---------------- 未启用：输入恢复码 ---------------- */
        <section className="panel">
          <h2>启用同步</h2>
          <p className="muted small">
            第一台设备：点「随机生成」产生一个新恢复码，为<strong>当前账号</strong>创建同步空间。
            另一台设备：先<strong>登录同一个账号</strong>，再粘贴第一台设备显示的恢复码接入。
            不同账号即使填了完全相同的恢复码，也会进入各自独立的空间，不会合并、不会串数据。
            恢复码 = 64 位十六进制（8 组 × 8 位），只在启用时显示一次，请务必抄写保存。
          </p>
          <div className="btn-row">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="xxxxxxxx-xxxxxxxx-…（8 组 × 8 位）"
              aria-label="恢复码"
              style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}
            />
            <button className="mini" onClick={() => setCode(generateRecoveryCode())}>
              随机生成
            </button>
          </div>
          <div className="btn-row">
            <button
              className="primary"
              disabled={enableM.isPending || code.trim().length < 16}
              onClick={() => enableM.mutate()}
            >
              {enableM.isPending ? '正在启用（首传可能较慢）…' : '启用同步'}
            </button>
          </div>
          <p className="muted small">
            启用后会立即把本地全部数据（简历 / 公司 / 岗位 / 投递 / 附件等）做一次基线全量首传。
          </p>
        </section>
      ) : (
        /* ---------------- 已启用：状态 + 操作 ---------------- */
        <>
          {setupResult && (
            <section className="panel" style={{ border: '1px solid #000' }}>
              <h2>恢复码（仅显示这一次）</h2>
              <p className="muted small">
                另一台设备<strong>登录同一账号</strong>后靠这串码接入本账号的空间。
                服务端只存派生密钥，<strong>关闭页面后无法再次查看</strong>，
                请立即抄写或复制到密码管理器。
              </p>
              <div className="btn-row">
                <code
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    background: '#f5f5f5',
                    fontSize: 13,
                    wordBreak: 'break-all',
                    userSelect: 'all',
                  }}
                >
                  {setupResult.recoveryCode}
                </code>
                <button className="mini" onClick={() => void copyCode(setupResult.recoveryCode)}>
                  {codeCopied ? '已复制' : '复制'}
                </button>
              </div>
            </section>
          )}

          <section className="panel">
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <h2>
                同步状态
                <span className="tag" style={{ marginLeft: 8 }}>{statusLabel}</span>
              </h2>
              <div className="btn-row">
                <button
                  className="primary"
                  disabled={runM.isPending || status.status === 'syncing'}
                  onClick={() => runM.mutate()}
                >
                  {runM.isPending ? '同步中…' : '立即同步'}
                </button>
                {confirmDisable ? (
                  <>
                    <button
                      className="mini"
                      disabled={disableM.isPending}
                      onClick={() => disableM.mutate()}
                    >
                      确认停用
                    </button>
                    <button className="mini" onClick={() => setConfirmDisable(false)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="mini" onClick={() => setConfirmDisable(true)}>
                    停用同步
                  </button>
                )}
              </div>
            </div>

            <div className="cf-meta">
              <div>
                服务器 <span className="mono">{status.baseUrl}</span>
              </div>
              <div>
                本账号同步空间 <span className="mono">{status.vaultId?.slice(0, 16)}…</span>
              </div>
              <div>
                本机设备 <span className="mono">{status.deviceId?.slice(0, 8)}…</span>
              </div>
              <div>
                最近同步 <span>{status.lastSyncAt ? fmtTime(status.lastSyncAt) : '尚未同步'}</span>
              </div>
              <div>
                云端游标 <span className="mono">{status.pulledSeq}</span>
              </div>
              <div>
                本地游标{' '}
                <span className="mono">
                  {status.pushedCursor === '' ? '待基线首传' : status.pushedCursor}
                </span>
              </div>
            </div>

            {status.lastError && (
              <div className="alert" style={{ marginTop: 8 }}>
                上次同步出错：{status.lastError}
              </div>
            )}

            <p className="muted small" style={{ marginTop: 10 }}>
              两台设备同时编辑同一条记录时，按 HLC 做 last-write-wins，落败方的整行原文会留进
              <a href="#/conflicts"> 冲突恢复</a>，可随时人工恢复。停用只清配置，本地数据与已下载附件全部保留。
              每个账号的同步空间、密钥与进度彼此独立，多台设备共用同一云端服务也不会互相干扰。
            </p>
          </section>
        </>
      )}
    </>
  );
}
