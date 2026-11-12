/* =============================================================
 * N14 · 同题前后答案的单词级 Diff（纯函数 LCS，零依赖）。
 *
 * 分词策略：中文单字成 token，连续拉丁字母/数字成词，空白独立成 token，
 * 这样中英混排也能得到可读的差异分段。只读展示用，不做合并。
 * ============================================================= */

export interface DiffSegment {
  text: string;
  type: 'same' | 'add' | 'del';
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const CJK = /[\u4e00-\u9fa5]/;
  const WORD = /[A-Za-z0-9]/;
  const SPACE = /\s/;
  while (i < s.length) {
    const ch = s[i];
    if (CJK.test(ch)) {
      out.push(ch);
      i += 1;
    } else if (WORD.test(ch)) {
      let j = i;
      while (j < s.length && WORD.test(s[j])) j += 1;
      out.push(s.slice(i, j));
      i = j;
    } else if (SPACE.test(ch)) {
      let j = i;
      while (j < s.length && SPACE.test(s[j])) j += 1;
      out.push(s.slice(i, j));
      i = j;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out;
}

/** 返回 token 级的最长公共子序列回溯矩阵（LCS 长度）。 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** 把两段文本做 token 级 LCS diff，返回分段（same / add / del）。 */
export function diffText(a: string, b: string): DiffSegment[] {
  const ta = tokenize(a || '');
  const tb = tokenize(b || '');
  const dp = lcsTable(ta, tb);
  const segs: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < ta.length && j < tb.length) {
    if (ta[i] === tb[j]) {
      segs.push({ text: ta[i], type: 'same' });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      segs.push({ text: ta[i], type: 'del' });
      i += 1;
    } else {
      segs.push({ text: tb[j], type: 'add' });
      j += 1;
    }
  }
  while (i < ta.length) {
    segs.push({ text: ta[i], type: 'del' });
    i += 1;
  }
  while (j < tb.length) {
    segs.push({ text: tb[j], type: 'add' });
    j += 1;
  }
  return segs;
}
