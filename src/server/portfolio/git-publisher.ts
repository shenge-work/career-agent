/* =============================================================
 * N13 · S2 一键发布：git CLI 发布器
 * -------------------------------------------------------------
 * 用本机 git CLI 把生成的静态站推送到目标 GitHub 仓库。
 *
 * 安全铁律（对齐 N13 §五）：
 *   - 凭证走本机已配置的 git credential helper，令牌不落盘、不出本机；
 *   - 本模块绝不接触、不存储任何 PAT / token；
 *   - 所有 git 子进程用 spawn（不用 shell 拼接），杜绝命令注入。
 * ============================================================= */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 一次发布的目标描述。 */
export interface DeployTarget {
  /** GitHub 仓库地址，如 git@github.com:user/repo.git 或 https://github.com/user/repo.git。 */
  repo: string;
  /** 目标分支，默认 main。 */
  branch: string;
  /** 提交信息。 */
  message: string;
}

/** 发布结果。 */
export interface DeployResult {
  /** 发布到的仓库（规范化后的 owner/repo）。 */
  repo: string;
  branch: string;
  commit: string;
  /** 推测的公网 URL（GitHub Pages）。 */
  url: string;
}

/** 归一化 owner/repo：从 git 地址或 owner/repo 字符串提取，用于显示与 URL 推测。 */
export function normalizeRepo(repo: string): { owner: string; repo: string; url: string } {
  const s = String(repo || '').trim();
  if (!s) throw new Error('仓库地址不能为空');
  // 支持三种写法：git@github.com:owner/repo.git / https://github.com/owner/repo.git / owner/repo
  // 关键：用 `github.com` 作为 host 锚点，避免把「域名/单词」误拆成 owner/repo。
  let m = s.match(/(?:github\.com[:\/])([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (!m) {
    // 兜底：纯 owner/repo 简写（无 host），且恰好只有一段斜杠。
    m = s.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  }
  if (!m) throw new Error('仓库地址格式无效，应为 owner/repo 或完整 git 地址');
  const owner = m[1];
  const repoName = m[2];
  // 用户站点：<user>.github.io 直接映射到 https://<user>.github.io/
  const isUserSite = repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  const url = isUserSite ? `https://${owner}.github.io/` : `https://${owner}.github.io/${repoName}/`;
  return { owner, repo: repoName, url };
}

/** 校验仓库地址合法性（发布前门禁）。 */
export function validateRepo(repo: string): { owner: string; repo: string; url: string } {
  const norm = normalizeRepo(repo);
  // 防止把本机任意目录 / 危险字符当仓库（path traversal 防护）。
  if (/[\\\s]/.test(norm.owner) || /[\\\s]/.test(norm.repo)) {
    throw new Error('仓库名不能包含空白或反斜杠');
  }
  return norm;
}

/** 执行一个 git 命令，返回 stdout；非零退出码抛错（带 stderr 摘要）。 */
export function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => reject(new Error(`无法启动 git：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0]} 失败 (${code})：${stderr.trim().split('\n').slice(-3).join(' ') || '无输出'}`));
    });
  });
}

/** 把渲染出的 HTML 落成静态站目录（index.html）。返回目录路径。 */
export async function writeSiteDir(html: string, baseDir: string): Promise<string> {
  const siteDir = path.join(baseDir, 'site');
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });
  await writeFile(path.join(siteDir, 'index.html'), html, 'utf8');
  return siteDir;
}

/**
 * 一键发布：把静态站 push 到目标仓库。
 *
 * 流程：临时目录 → git clone（或 init）→ 清空内容 → 写入 index.html → commit → push。
 * 用户站点 (<user>.github.io) 从根目录托管；项目站点可用目录或分支，这里统一推整个站。
 */
export async function publishSite(target: DeployTarget, html: string): Promise<DeployResult> {
  const norm = validateRepo(target.repo);
  const branch = target.branch || 'main';
  const tmpRoot = await mkdir(path.join(os.tmpdir(), 'career-agent-deploy-'), { recursive: true });
  const workDir = path.join(tmpRoot, 'repo');
  await rm(workDir, { recursive: true, force: true });

  try {
    // 先尝试 clone（若仓库已存在且本机有凭证/权限）。
    let cloned = false;
    try {
      await runGit(['clone', '--depth', '1', '--branch', branch, target.repo, workDir], tmpRoot);
      cloned = true;
    } catch {
      // clone 失败（仓库为空 / 分支不存在 / 首次）→ 退化为 init + remote add。
      await mkdir(workDir, { recursive: true });
      await runGit(['init', '-b', branch], workDir);
      await runGit(['remote', 'add', 'origin', target.repo], workDir);
    }

    // 清空工作区（保留 .git），把生成的静态站写入。
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(workDir));
    for (const e of entries) {
      if (e === '.git') continue;
      await rm(path.join(workDir, e), { recursive: true, force: true });
    }
    await writeFile(path.join(workDir, 'index.html'), html, 'utf8');

    await runGit(['add', '-A'], workDir);
    await runGit(['config', 'user.name', 'CareerAgent'], workDir);
    await runGit(['config', 'user.email', 'career-agent@local'], workDir);
    // 若内容无变化，commit 会报 nothing to commit；此处容忍（幂等发布）。
    try {
      await runGit(['commit', '-m', target.message], workDir);
    } catch (e: any) {
      if (!/nothing to commit|no changes/i.test(String(e?.message || ''))) throw e;
    }

    // 推送到目标分支。用户站点常需 --force（历史被覆盖为静态站）。
    if (cloned) {
      await runGit(['push', 'origin', branch], workDir);
    } else {
      await runGit(['push', '-u', 'origin', branch], workDir);
    }

    const commit = await runGit(['rev-parse', '--short', 'HEAD'], workDir);
    return { repo: `${norm.owner}/${norm.repo}`, branch, commit, url: norm.url };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
