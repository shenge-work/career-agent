import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  evaluatePracticeAnswer,
  generatePracticeQuestions,
  getPracticeSession,
  practiceFollowUp,
  retryPracticeQuestion,
  savePracticeDraft,
  selfEvaluatePracticeAnswer,
  settlePracticeSession,
  submitFirstAnswer,
  submitPracticeAnswer,
  updatePracticeSessionStatus,
  type PracticeAnswer,
  type PracticeEvaluation,
  type PracticeQuestion,
} from '../api';
import './interview/styles.css';

const DIM_ORDER = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const DIM_NAMES: Record<string, string> = {
  D1: '结构与完整性',
  D2: '相关性与岗位匹配',
  D3: '证据具体性',
  D4: '表达清晰与简洁',
  D5: '逻辑自洽与抗压',
  D6: '篇幅与时间控制',
};

function sortedAnswers(q: PracticeQuestion): PracticeAnswer[] {
  return (q.answers || []).slice().sort((a, b) => a.turn - b.turn);
}

/**
 * N14 · 练习 + 反馈页。
 *   · 左：题目 / 追问 / 回答编辑（草稿 800ms 防抖 + blur + beforeunload）；
 *   · 右：反馈三件套（做得好 / 6 维评分 / 可执行动作 / 范例答案）。
 */
export default function InterviewSession() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [idx, setIdx] = useState(0);
  const [draft, setDraft] = useState('');
  const [draftAnswerId, setDraftAnswerId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [selfOpen, setSelfOpen] = useState(false);
  const [selfLevels, setSelfLevels] = useState<Record<string, number>>({});
  const [sampleOpen, setSampleOpen] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const draftRef = useRef<{ answerId: string | null; text: string }>({ answerId: null, text: '' });

  const { data: session, isLoading } = useQuery({
    queryKey: ['practice-session', sessionId],
    queryFn: () => getPracticeSession(sessionId),
    enabled: !!sessionId,
  });

  const questions = session?.questions || [];
  const q = questions[idx];

  // 切换题目 / 数据刷新时，把当前待答草稿同步到编辑框
  useEffect(() => {
    if (!q) {
      setDraft('');
      setDraftAnswerId(null);
      return;
    }
    const cur = sortedAnswers(q).find((a) => a.isDraft) || null;
    setDraft(cur ? cur.answer : '');
    setDraftAnswerId(cur ? cur.id : null);
    setSelfOpen(false);
    setSampleOpen(false);
  }, [q]);

  draftRef.current = { answerId: draftAnswerId, text: draft };

  const doSaveDraft = useCallback((answerId: string | null, text: string) => {
    if (!answerId) return;
    savePracticeDraft(answerId, text).catch(() => {});
  }, []);

  // 800ms 防抖自动保存
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      doSaveDraft(draftAnswerId, draft);
    }, 800);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [draft, draftAnswerId, doSaveDraft]);

  // 关闭 / 刷新前尽力把草稿写回（keepalive）
  useEffect(() => {
    const flush = () => {
      const { answerId, text } = draftRef.current;
      if (!answerId) return;
      fetch(`/api/practice/answers/${encodeURIComponent(answerId)}/draft`, {
        method: 'PUT',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: text }),
      }).catch(() => {});
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['practice-session', sessionId] });
    qc.invalidateQueries({ queryKey: ['practice-sessions'] });
    qc.invalidateQueries({ queryKey: ['practice-weaknesses'] });
  };

  const genM = useMutation({
    mutationFn: () => generatePracticeQuestions(sessionId, Number(session?.goal?.questionCount) || 3),
    onSuccess: () => {
      setIdx(0);
      invalidate();
    },
    onError: (e) => setError((e as Error).message),
  });

  const submitM = useMutation({
    mutationFn: async () => {
      if (!q) throw new Error('当前无题目');
      const cur = sortedAnswers(q).find((a) => a.isDraft);
      if (!cur) throw new Error('没有待提交的回答');
      if (cur.turn === 0) {
        return await submitFirstAnswer(q.id, draft);
      }
      await submitPracticeAnswer(cur.id, draft);
      return await evaluatePracticeAnswer(cur.id);
    },
    onSuccess: () => {
      setDraft('');
      setSelfOpen(false);
      invalidate();
    },
    onError: (e) => setError((e as Error).message),
  });

  const fuM = useMutation({
    mutationFn: () => {
      if (!q) throw new Error('当前无题目');
      const last = [...sortedAnswers(q)].reverse().find((a) => !a.isDraft);
      if (!last) throw new Error('请先提交本题回答');
      return practiceFollowUp(q.id, last.id);
    },
    onSuccess: (r) => {
      if (r.enough) setNote('追问已充分，无需继续追问。');
      invalidate();
    },
    onError: (e) => setError((e as Error).message),
  });

  const retryM = useMutation({
    mutationFn: () => retryPracticeQuestion(q!.id),
    onSuccess: (r) => navigate(`/interview/${r.session.id}`),
    onError: (e) => setError((e as Error).message),
  });

  const pauseM = useMutation({
    mutationFn: () => updatePracticeSessionStatus(sessionId, 'paused'),
    onSuccess: () => invalidate(),
    onError: (e) => setError((e as Error).message),
  });

  const settleM = useMutation({
    mutationFn: () => settlePracticeSession(sessionId),
    onSuccess: () => invalidate(),
    onError: (e) => setError((e as Error).message),
  });

  const selfM = useMutation({
    mutationFn: () => {
      const cur = sortedAnswers(q!).find((a) => a.isDraft);
      const target = cur || [...sortedAnswers(q!)].reverse().find((a) => !a.isDraft);
      if (!target) throw new Error('没有可自评的回答');
      const dims = DIM_ORDER.map((d) => ({ dimension: d, level: Number(selfLevels[d] || 1) }));
      return selfEvaluatePracticeAnswer(target.id, dims);
    },
    onSuccess: () => {
      setSelfOpen(false);
      invalidate();
    },
    onError: (e) => setError((e as Error).message),
  });

  const latestAiEval: PracticeEvaluation | null = useMemo(() => {
    if (!q) return null;
    const evals = (q.evaluations || []).filter((e) => e.source === 'ai');
    return evals.length ? evals[evals.length - 1] : null;
  }, [q]);

  if (isLoading) return <div className="iv-page iv-muted">正在加载练习会话…</div>;
  if (!session) return <div className="iv-page iv-muted">会话不存在</div>;

  const goal = session.goal || {};
  const currentDraft = q ? sortedAnswers(q).find((a) => a.isDraft) || null : null;
  const lastSubmitted = q ? [...sortedAnswers(q)].reverse().find((a) => !a.isDraft) || null : null;

  const copyAction = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => setNote('已复制改写建议')).catch(() => {});
  };

  return (
    <div className="iv-page">
      <div className="iv-head">
        <div>
          <h1>面试练习</h1>
          <p className="iv-sub">
            {goal.questionType === 'mixed' ? '通用' : goal.questionType} · {goal.difficulty} ·{' '}
            {goal.questionCount || 0} 题 · {session.status === 'paused' ? '已暂停' : session.status === 'completed' ? '已完成' : '进行中'}
          </p>
        </div>
        <div className="iv-row">
          <Link className="iv-btn ghost small" to="/interview">
            ← 返回
          </Link>
          {session.status !== 'completed' && (
            <button className="iv-btn ghost small" onClick={() => pauseM.mutate()} disabled={pauseM.isPending}>
              暂停
            </button>
          )}
          {session.status === 'paused' && (
            <button className="iv-btn small" onClick={() => updatePracticeSessionStatus(sessionId, 'active').then(invalidate)}>
              继续练习
            </button>
          )}
        </div>
      </div>

      {error && <div className="iv-alert">{error}</div>}
      {note && <div className="iv-hint" style={{ marginBottom: 12 }}>{note}</div>}

      {questions.length === 0 ? (
        <div className="iv-card">
          <h2>开始出题</h2>
          <p className="iv-sub" style={{ marginBottom: 12 }}>
            将基于你的简历、JD 与待复习弱项生成题目；未配置 AI 时使用内置本地题库。
          </p>
          <button className="iv-btn" onClick={() => genM.mutate()} disabled={genM.isPending}>
            {genM.isPending ? '出题中…' : '开始练习'}
          </button>
        </div>
      ) : (
        <div className="iv-split">
          {/* 左：作答 */}
          <div className="iv-card">
            <div className="iv-progress">
              {questions.map((_, i) => (
                <span key={i} className={'iv-progress-dot' + (i === idx ? ' on' : '')} />
              ))}
              <span className="iv-muted iv-small" style={{ marginLeft: 6 }}>
                {idx + 1} / {questions.length}
              </span>
            </div>

            <div className="iv-bubble-meta">面试官 · 第 {idx + 1} 题</div>
            <div className="iv-bubble interviewer">{q.question}</div>

            {sortedAnswers(q)
              .filter((a) => a.turn > 0)
              .map((a) => (
                <div key={a.id} style={{ marginTop: 10 }}>
                  <div className="iv-bubble-meta">追问 {a.turn}/{q.maxFollowUps || 2}</div>
                  <div className="iv-bubble interviewer">{a.prompt}</div>
                  {a.isDraft ? null : <div className="iv-bubble me">{a.answer}</div>}
                </div>
              ))}

            {currentDraft ? (
              <>
                <textarea
                  className="iv-textarea"
                  value={draft}
                  placeholder="输入你的回答…（草稿自动保存）"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => doSaveDraft(draftAnswerId, draft)}
                  disabled={session.status === 'completed'}
                />
                <div className="iv-draft-state">
                  {draft.trim() ? `草稿已自动保存 · ${draft.trim().length} 字` : '草稿自动保存已开启'}
                </div>
                <div className="iv-row" style={{ marginTop: 10 }}>
                  <button
                    className="iv-btn"
                    onClick={() => submitM.mutate()}
                    disabled={submitM.isPending || !draft.trim() || session.status === 'completed'}
                  >
                    {submitM.isPending ? '评分中…' : '提交本题'}
                  </button>
                  <button className="iv-btn ghost" onClick={() => setSelfOpen((v) => !v)}>
                    自评
                  </button>
                </div>
              </>
            ) : (
              <div className="iv-row" style={{ marginTop: 12 }}>
                <button
                  className="iv-btn ghost"
                  onClick={() => fuM.mutate()}
                  disabled={fuM.isPending || !lastSubmitted || session.status === 'completed'}
                >
                  追问（≤{q.maxFollowUps || 2} 层）
                </button>
                <button className="iv-btn ghost" onClick={() => setSelfOpen((v) => !v)}>
                  自评
                </button>
              </div>
            )}

            {selfOpen && (
              <div className="iv-card" style={{ marginTop: 12 }}>
                <p className="iv-section-title">自评 Rubric（不计入画像）</p>
                {DIM_ORDER.map((d) => (
                  <div key={d} className="iv-row" style={{ justifyContent: 'space-between' }}>
                    <span className="iv-small">{DIM_NAMES[d]}</span>
                    <select
                      value={selfLevels[d] || 1}
                      onChange={(e) => setSelfLevels((prev) => ({ ...prev, [d]: Number(e.target.value) }))}
                    >
                      {[1, 2, 3, 4].map((l) => (
                        <option key={l} value={l}>
                          {l} 档
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <div className="iv-row" style={{ marginTop: 10 }}>
                  <button className="iv-btn small" onClick={() => selfM.mutate()} disabled={selfM.isPending}>
                    保存自评
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 右：反馈 */}
          <div className="iv-card">
            {latestAiEval ? (
              <FeedbackPanel
                evaluation={latestAiEval}
                sampleOpen={sampleOpen}
                onToggleSample={() => setSampleOpen((v) => !v)}
                onCopy={copyAction}
              />
            ) : (
              <div className="iv-empty">
                {submitM.isPending
                  ? '评分生成中…'
                  : lastSubmitted
                  ? '本题尚无 AI 评分（未配置 AI 时可自评）。'
                  : '提交回答后，这里会显示反馈三件套（做得好 / 6 维评分 / 可执行动作 / 范例答案）。'}
              </div>
            )}

            <div className="iv-row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
              <div className="iv-row">
                <button className="iv-btn ghost small" onClick={() => retryM.mutate()} disabled={retryM.isPending}>
                  同题重练
                </button>
                {idx + 1 < questions.length ? (
                  <button className="iv-btn small" onClick={() => setIdx((v) => v + 1)}>
                    下一题
                  </button>
                ) : (
                  session.status !== 'completed' && (
                    <button className="iv-btn small" onClick={() => settleM.mutate()} disabled={settleM.isPending}>
                      完成练习
                    </button>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="iv-footer-note">
        AI 评分仅作自我练习参考，不用于真实录用决策 · 本次会话 AI 调用 {session.usage?.calls || 0} 次
      </div>
    </div>
  );
}

function FeedbackPanel({
  evaluation,
  sampleOpen,
  onToggleSample,
  onCopy,
}: {
  evaluation: PracticeEvaluation;
  sampleOpen: boolean;
  onToggleSample: () => void;
  onCopy: (text: string) => void;
}) {
  const dims = evaluation.dimensions || [];
  return (
    <div className="iv-feedback">
      {evaluation.status === 'not_generated' && (
        <div className="iv-hint">这次评分没生成，答案已保留，可重试。</div>
      )}
      {evaluation.status === 'pending_retry' && (
        <div className="iv-hint">评分上游失败，答案已保留，可稍后重试。</div>
      )}

      {evaluation.strengths && evaluation.strengths.length > 0 && (
        <div className="iv-fb-block">
          <h3>做得好</h3>
          {evaluation.strengths.map((s, i) => (
            <div key={i} className="iv-action-item">
              <span className="iv-action-marker">▪</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      )}

      <div className="iv-fb-block">
        <h3>分维度 Rubric（1–4 档）</h3>
        {DIM_ORDER.map((code) => {
          const d = dims.find((x) => x.dimension === code);
          const level = d?.level || 0;
          return (
            <div key={code}>
              <div className="iv-dim-row">
                <span className="iv-dim-name">{DIM_NAMES[code]}</span>
                <span className="iv-level-track">
                  <span className="iv-level-fill" style={{ width: `${(level / 4) * 100}%` }} />
                </span>
                <span className="iv-level-num">{level || '—'}</span>
                <span className="iv-delta">{code}</span>
              </div>
              {d?.reason && <div className="iv-dim-reason">{d.reason}</div>}
            </div>
          );
        })}
      </div>

      {evaluation.actions && evaluation.actions.length > 0 && (
        <div className="iv-fb-block">
          <h3>下一步（可执行）</h3>
          {evaluation.actions.map((a, i) => (
            <div key={i} className="iv-action-item">
              <span className="iv-action-marker">▪</span>
              <span>{a}</span>
              <button className="iv-btn ghost small" onClick={() => onCopy(a)}>
                复制
              </button>
            </div>
          ))}
        </div>
      )}

      {evaluation.sampleAnswer && (
        <div className="iv-fb-block">
          <h3>
            参考范例答案（示范，非标准）
            <button className="iv-btn ghost small" style={{ marginLeft: 8 }} onClick={onToggleSample}>
              {sampleOpen ? '收起' : '展开'}
            </button>
          </h3>
          {sampleOpen && <div className="iv-sample">{evaluation.sampleAnswer}</div>}
        </div>
      )}

      {evaluation.summary && <div className="iv-muted iv-small">{evaluation.summary}</div>}
    </div>
  );
}
