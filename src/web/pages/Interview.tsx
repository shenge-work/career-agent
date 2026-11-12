import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  createPracticeSession,
  retryPracticeQuestion,
  type ApplicationItem,
  type PracticeSession,
  type PracticeWeakness,
  type ResumeItem,
} from '../api';
import './interview/styles.css';

/**
 * N14 · AI 面试练习入口：快速开始 + 待复习清单 + 最近会话列表。
 * 无 Key 时顶部给灰阶提示条与配置入口（本地题库 + 自评仍可用）。
 */
export default function Interview() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    questionType: 'mixed',
    difficulty: 'standard',
    questionCount: '3',
    applicationId: '',
    resumeId: '',
    jdText: '',
  });
  const [error, setError] = useState('');

  const { data: aiStatus } = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<{ configured: boolean }>('/ai/status'),
  });
  const { data: sessions = [] } = useQuery({
    queryKey: ['practice-sessions'],
    queryFn: () => api<PracticeSession[]>('/practice/sessions'),
  });
  const { data: weaknesses = [] } = useQuery({
    queryKey: ['practice-weaknesses'],
    queryFn: () => api<PracticeWeakness[]>('/practice/weaknesses'),
  });
  const { data: applications = [] } = useQuery({
    queryKey: ['applications'],
    queryFn: () => api<ApplicationItem[]>('/applications'),
  });
  const { data: resumes = [] } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => api<ResumeItem[]>('/resumes'),
  });

  const createM = useMutation({
    mutationFn: () =>
      createPracticeSession({
        applicationId: form.applicationId || null,
        resumeId: form.resumeId || null,
        jdText: form.jdText || undefined,
        questionType: form.questionType,
        difficulty: form.difficulty,
        questionCount: Number(form.questionCount),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['practice-sessions'] });
      navigate(`/interview/${r.id}`);
    },
    onError: (e) => setError((e as Error).message),
  });

  const retryM = useMutation({
    mutationFn: (questionId: string) => retryPracticeQuestion(questionId),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['practice-sessions'] });
      qc.invalidateQueries({ queryKey: ['practice-weaknesses'] });
      navigate(`/interview/${r.session.id}`);
    },
    onError: (e) => setError((e as Error).message),
  });

  const specialM = useMutation({
    mutationFn: () =>
      createPracticeSession({
        questionType: 'mixed',
        difficulty: 'standard',
        questionCount: 3,
      }),
    onSuccess: (r) => navigate(`/interview/${r.id}`),
    onError: (e) => setError((e as Error).message),
  });

  const statusLabel: Record<string, string> = {
    configuring: '未开始',
    active: '进行中',
    paused: '已暂停',
    completed: '已完成',
  };

  const goalOf = (s: PracticeSession) => {
    const g = s.goal || {};
    return [g.questionType === 'mixed' ? '通用' : g.questionType, g.difficulty, `${g.questionCount || 0} 题`]
      .filter(Boolean)
      .join(' / ');
  };

  return (
    <div className="iv-page">
      <div className="iv-head">
        <div>
          <h1>AI 面试练习</h1>
          <p className="iv-sub">基于简历 + JD + 弱项出题，逐题评分并沉淀可重练的进步闭环。</p>
        </div>
        <Link className="iv-btn ghost small" to="/interview/growth">
          成长 / 复盘
        </Link>
      </div>

      {error && <div className="iv-alert">{error}</div>}
      {aiStatus && !aiStatus.configured && (
        <div className="iv-hint" style={{ marginBottom: 16 }}>
          尚未配置大模型：AI 出题 / 追问 / 评分不可用，但你仍可用内置题库练习并自评。
          <Link to="/account" style={{ marginLeft: 8, color: '#1a1a1a', fontWeight: 700 }}>
            去配置 →
          </Link>
        </div>
      )}

      {/* 快速开始 */}
      <div className="iv-card">
        <h2>快速开始</h2>
        <div className="iv-row">
          <label className="iv-field">
            题型
            <select value={form.questionType} onChange={(e) => setForm({ ...form, questionType: e.target.value })}>
              <option value="mixed">通用混合</option>
              <option value="behavioral">行为面（STAR）</option>
              <option value="project">项目深挖</option>
              <option value="hr">HR 动机</option>
              <option value="system_design">系统设计口述</option>
            </select>
          </label>
          <label className="iv-field">
            难度
            <select value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value })}>
              <option value="easy">简单</option>
              <option value="standard">标准</option>
              <option value="hard">困难</option>
            </select>
          </label>
          <label className="iv-field">
            题量
            <select value={form.questionCount} onChange={(e) => setForm({ ...form, questionCount: e.target.value })}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} 题
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="iv-row">
          <label className="iv-field">
            关联岗位（可选）
            <select value={form.applicationId} onChange={(e) => setForm({ ...form, applicationId: e.target.value })}>
              <option value="">不关联</option>
              {applications.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.position}
                </option>
              ))}
            </select>
          </label>
          <label className="iv-field">
            简历（可选）
            <select value={form.resumeId} onChange={(e) => setForm({ ...form, resumeId: e.target.value })}>
              <option value="">主简历</option>
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="iv-row">
          <label className="iv-field" style={{ flex: 1 }}>
            JD 文本（可选，自动带入岗位时忽略）
            <textarea
              value={form.jdText}
              onChange={(e) => setForm({ ...form, jdText: e.target.value })}
              placeholder="粘贴 JD 原文，用于个性化出题…"
            />
          </label>
        </div>
        <div className="iv-row" style={{ marginTop: 12 }}>
          <button className="iv-btn" onClick={() => createM.mutate()} disabled={createM.isPending}>
            {createM.isPending ? '创建中…' : '开始练习'}
          </button>
        </div>
      </div>

      {/* 待复习清单 */}
      <div className="iv-card">
        <p className="iv-section-title">待复习清单</p>
        {weaknesses.length === 0 ? (
          <div className="iv-empty">暂无弱项，完成练习并结算后自动生成。</div>
        ) : (
          <ul className="iv-list">
            {weaknesses.map((w) => (
              <li key={w.id} className="iv-list-item">
                <div className="iv-list-main">
                  <div className="iv-list-title">
                    {w.dimension ? (
                      <span className="iv-tag dim">{w.dimension}</span>
                    ) : null}
                    {w.reason}
                  </div>
                  <div className="iv-list-meta">
                    来源 {w.source === 'dimension' ? '维度' : w.source === 'question' ? '题目' : '真实复盘'} ·{' '}
                    {w.status === 'pending' ? '待复习' : w.status === 'practiced' ? '已重练' : '已收敛'}
                  </div>
                </div>
                <div className="iv-row">
                  {w.source === 'question' && w.questionId && (
                    <button className="iv-btn ghost small" onClick={() => retryM.mutate(w.questionId!)}>
                      同题重练
                    </button>
                  )}
                  {w.source === 'dimension' && (
                    <button className="iv-btn ghost small" onClick={() => specialM.mutate()}>
                      专项重练
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 最近会话 */}
      <div className="iv-card">
        <p className="iv-section-title">最近会话</p>
        {sessions.length === 0 ? (
          <div className="iv-empty">还没有练习会话，点击「开始练习」创建第一场。</div>
        ) : (
          <ul className="iv-list">
            {sessions.map((s) => (
              <li key={s.id} className="iv-list-item">
                <div className="iv-list-main">
                  <div className="iv-list-title">{goalOf(s)}</div>
                  <div className="iv-list-meta">
                    {s.startedAt ? new Date(s.startedAt).toLocaleDateString('zh-CN') : '未开始'} ·{' '}
                    {statusLabel[s.status] || s.status}
                  </div>
                </div>
                <Link className="iv-btn ghost small" to={`/interview/${s.id}`}>
                  {s.status === 'completed' ? '查看反馈' : s.status === 'configuring' ? '开始练习' : '继续练习'}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
