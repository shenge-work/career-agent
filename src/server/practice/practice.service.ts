import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AiProxyError, AiService } from '../ai/ai.service';
import { TenantDb } from '../tenant/tenant-db';
import type { PracticeSessionPatch } from '../tenant/tenant-db';
import { pickLocalQuestions, type QuestionType } from './local-question-bank';
import {
  buildFollowUpMessages,
  buildQuestionsMessages,
  buildSampleAnswerMessages,
  buildScoreMessages,
  fallbackSampleAnswer,
  flattenResume,
  parseJsonLoose,
  pickDimension,
} from './prompts';
import {
  DIMENSION_CODES,
  isDimensionCode,
  normalizeScore,
  normalizeSelfScore,
  PROMPT_VERSION,
  RUBRIC_DIMENSIONS,
  RUBRIC_VERSION,
  type DimensionCode,
  type PracticeScore,
} from './rubric';

const newId = (prefix: string) => prefix + '_' + randomBytes(9).toString('hex');

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

const QUESTION_TYPES: QuestionType[] = ['behavioral', 'project', 'hr', 'system_design'];
const DIFFICULTIES = ['easy', 'standard', 'hard'] as const;

interface QuestionDraft {
  question: string;
  type: QuestionType;
  dimension: DimensionCode | null;
  difficulty: 'easy' | 'standard' | 'hard';
  basis: Json;
}

/**
 * N14 · AI 面试练习编排层。
 *
 * 会话/题目/回答/评分/画像聚合/弱项/重练/沉淀面经都在这里编排；AI 全走
 * AiService.complete（非流式结构化补全），未配置 / 解析失败走降级，不产低分、不写画像。
 * 所有查询经 TenantDb.forUser(userId)，跨用户资源一律 404。
 */
@Injectable()
export class PracticeService {
  constructor(
    @Inject(TenantDb) private readonly tenant: TenantDb,
    private readonly ai: AiService
  ) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  private optId(v: unknown): string | null {
    return v == null || v === '' ? null : String(v);
  }
  private optStr(v: unknown): string | null {
    return v == null ? null : String(v).trim();
  }
  private strArr(v: unknown): string[] {
    return Array.isArray(v) ? v.slice(0, 40).map((x) => String(x).trim()).filter(Boolean) : [];
  }
  private clampInt(v: unknown, min: number, max: number, dft: number): number {
    const n = v === undefined || v === null || v === '' ? dft : Number(v);
    if (!Number.isInteger(n)) return dft;
    return Math.max(min, Math.min(n, max));
  }

  private async requireSession(userId: string, id: string) {
    const rows = await this.t(userId).getPracticeSession(id);
    if (!rows.length) throw new NotFoundException('练习会话不存在');
    return rows[0];
  }

  private async requireQuestion(userId: string, id: string) {
    const rows = await this.t(userId).getPracticeQuestion(id);
    if (!rows.length) throw new NotFoundException('练习题目不存在');
    return rows[0];
  }

  private async requireAnswer(userId: string, id: string) {
    const rows = await this.t(userId).getPracticeAnswer(id);
    if (!rows.length) throw new NotFoundException('练习回答不存在');
    return rows[0];
  }

  private async requireWeakness(userId: string, id: string) {
    const rows = await this.t(userId).getPracticeWeakness(id);
    if (!rows.length) throw new NotFoundException('弱项不存在');
    return rows[0];
  }

  /** 用量摘要：仅展示用，失败不影响主流程（真实用量由 AiService.bumpAiUsage 记账）。 */
  private async bumpUsage(userId: string, sessionId: string, model: string | null, used: boolean) {
    try {
      const rows = await this.t(userId).getPracticeSession(sessionId);
      const session = rows[0];
      if (!session) return;
      const usage = obj(session.usage);
      const calls = (Number(usage.calls) || 0) + (used ? 1 : 0);
      const models = Array.isArray(usage.models) ? usage.models.map((m) => String(m)) : [];
      if (model && !models.includes(model)) models.push(model);
      await this.t(userId).updatePracticeSession(sessionId, { usage: { calls, models } });
    } catch {
      /* noop */
    }
  }

  private async resumeTextOf(userId: string, resumeId: string | null): Promise<string> {
    let resume: any = null;
    if (resumeId) resume = (await this.t(userId).getResume(resumeId))[0] || null;
    if (!resume) {
      const all = await this.t(userId).listResumes();
      resume = all.find((r: any) => r.isMaster) || all[0] || null;
    }
    return resume ? flattenResume(resume.payload as Json) : '';
  }

  private async jdTextOf(
    userId: string,
    applicationId: string | null,
    resumeId: string | null,
    inputJd: unknown
  ): Promise<string> {
    const given = String(inputJd ?? '').trim();
    if (given) return given;
    if (applicationId) {
      const apps = await this.t(userId).getApplication(applicationId);
      const app = apps[0];
      if (app) {
        const p = obj(app.payload);
        if (typeof p.jdText === 'string' && p.jdText.trim()) return p.jdText.trim();
        if (app.jdId) {
          const jds = await this.t(userId).getCompanyJd(app.jdId);
          const jd = jds[0];
          const jp = jd ? obj(jd.payload) : {};
          const t = jp.jdText ?? jp.text ?? jp.jd;
          if (typeof t === 'string' && t.trim()) return t.trim();
        }
      }
    }
    if (resumeId) {
      const resumes = await this.t(userId).getResume(resumeId);
      const resume = resumes[0];
      if (resume?.jdText) return String(resume.jdText).trim();
    }
    return '';
  }

  /** 弱项上下文：把待复习维度拼成一句，供专项出题。 */
  private async weaknessContextOf(userId: string): Promise<string> {
    const list = await this.t(userId).listPracticeWeaknesses();
    const pending = list.filter((w: any) => w.status === 'pending');
    if (!pending.length) return '';
    return pending
      .map((w: any) => {
        if (w.dimension) {
          const dim = RUBRIC_DIMENSIONS.find((d) => d.code === w.dimension);
          return `${dim ? dim.name : w.dimension}（${w.reason}）`;
        }
        return w.reason;
      })
      .join('；');
  }

  // ---------------------------------------------------------- 会话

  listSessions(userId: string) {
    return this.t(userId).listPracticeSessions();
  }

  async createSession(
    userId: string,
    input: {
      applicationId?: unknown;
      resumeId?: unknown;
      jdText?: unknown;
      questionType?: unknown;
      difficulty?: unknown;
      questionCount?: unknown;
    }
  ) {
    const applicationId = this.optId(input.applicationId);
    if (applicationId) {
      const apps = await this.t(userId).getApplication(applicationId);
      if (!apps.length) throw new NotFoundException('关联岗位不存在');
    }
    const resumeId = this.optId(input.resumeId);
    if (resumeId) {
      const resumes = await this.t(userId).getResume(resumeId);
      if (!resumes.length) throw new NotFoundException('关联简历不存在');
    }

    const jdText = await this.jdTextOf(userId, applicationId, resumeId, input.jdText);
    const questionType =
      QUESTION_TYPES.includes(input.questionType as QuestionType) ? (input.questionType as QuestionType) : 'mixed';
    const difficulty = DIFFICULTIES.includes(input.difficulty as any) ? (input.difficulty as string) : 'standard';
    const questionCount = this.clampInt(input.questionCount, 1, 10, 3);

    const sourceTags: string[] = [];
    if (resumeId) sourceTags.push('resume');
    if (jdText) sourceTags.push('jd');
    if (applicationId) sourceTags.push('application');

    const goal: Json = {
      jdText,
      questionType,
      difficulty,
      questionCount,
      sourceTags,
      rubricVersion: RUBRIC_VERSION,
      promptVersion: PROMPT_VERSION,
      modelId: null,
      questionSource: resumeId ? 'resume' : jdText ? 'jd' : 'generic',
    };

    const rows = await this.t(userId).createPracticeSession({
      id: newId('ps'),
      status: 'configuring',
      applicationId,
      resumeId,
      goal,
      currentQuestionOrder: 0,
      usage: {},
      startedAt: null,
      completedAt: null,
    });
    return rows[0];
  }

  async getSession(userId: string, id: string) {
    const session = await this.requireSession(userId, id);
    const questions = await this.t(userId).listPracticeQuestions(id);
    const answers = await this.t(userId).listPracticeAnswersForSession(id);
    const tree = await Promise.all(
      questions.map(async (q: any) => {
        const qAnswers = answers.filter((a: any) => a.questionId === q.id);
        const evaluations = (
          await Promise.all(qAnswers.map((a: any) => this.t(userId).listPracticeEvaluations(a.id)))
        ).flat();
        return { ...q, answers: qAnswers, evaluations };
      })
    );
    return { ...session, questions: tree };
  }

  async updateStatus(userId: string, id: string, input: { status?: unknown }) {
    const session = await this.requireSession(userId, id);
    const status = input.status;
    if (!['active', 'paused', 'completed'].includes(status as string)) {
      throw new BadRequestException('status 只能是 active / paused / completed');
    }
    const patch: PracticeSessionPatch = { status: status as any };
    if (status === 'active' && !session.startedAt) patch.startedAt = new Date();
    if (status === 'completed') patch.completedAt = new Date();
    const rows = await this.t(userId).updatePracticeSession(id, patch);
    return rows[0];
  }

  // ---------------------------------------------------------- 出题

  async generateQuestions(userId: string, sessionId: string, count?: unknown) {
    const session = await this.requireSession(userId, sessionId);
    const goal = obj(session.goal);
    const questionCount = this.clampInt(count ?? goal.questionCount, 1, 10, 3);

    const resumeText = await this.resumeTextOf(userId, session.resumeId);
    const jdText = String(goal.jdText || '');
    const weaknessContext = await this.weaknessContextOf(userId);

    let drafts: QuestionDraft[] = [];
    let aiUsed = false;
    let model: string | null = null;

    try {
      const res = await this.ai.complete(userId, {
        messages: buildQuestionsMessages({
          jdText,
          resumeText,
          questionType: String(goal.questionType || 'mixed'),
          difficulty: String(goal.difficulty || 'standard'),
          questionCount,
          weaknessContext,
        }),
        temperature: 0.6,
        response_format: { type: 'json_object' },
      });
      const got = parseJsonLoose<{ questions: unknown[] }>(res.text);
      if (got && Array.isArray(got.questions)) {
        drafts = got.questions.map(normalizeQuestion).filter((q): q is QuestionDraft => !!q);
        if (drafts.length) {
          aiUsed = true;
          model = res.model;
        }
      }
    } catch {
      aiUsed = false;
      drafts = [];
    }

    if (!drafts.length) {
      drafts = pickLocalQuestions(goal, questionCount).map((q) => ({
        question: q.question,
        type: q.type,
        dimension: q.dimension,
        difficulty: q.difficulty,
        basis: { source: 'generic', excerpt: '' },
      }));
    }

    const existing = await this.t(userId).listPracticeQuestions(sessionId);
    let nextOrder = existing.length;

    const created: any[] = [];
    for (const draft of drafts) {
      const qid = newId('pq');
      const qRows = await this.t(userId).createPracticeQuestion({
        id: qid,
        sessionId,
        order: nextOrder,
        questionKey: qid, // 首答生成一次；同题重练沿用此键
        question: draft.question,
        type: draft.type,
        dimension: draft.dimension,
        difficulty: draft.difficulty,
        basis: draft.basis,
        maxFollowUps: 2,
        skipped: false,
        regeneratedFrom: null,
        weaknessId: null,
      });
      const qRow = qRows[0];
      const aRows = await this.t(userId).createPracticeAnswer({
        id: newId('pa'),
        sessionId,
        questionId: qid,
        turn: 0,
        prompt: draft.question,
        answer: '',
        isDraft: true,
        wordCount: 0,
        paraCount: 0,
        submittedAt: null,
      });
      const aRow = aRows[0];
      nextOrder += 1;
      created.push({ ...qRow, answers: [aRow] });
    }

    await this.t(userId).updatePracticeSession(sessionId, {
      status: 'active',
      startedAt: session.startedAt ?? new Date(),
      currentQuestionOrder: 0,
    });
    await this.bumpUsage(userId, sessionId, model, aiUsed);

    return {
      sessionId,
      questions: created,
      aiUsed,
      model,
      degraded: !aiUsed,
    };
  }

  // ---------------------------------------------------------- 回答 / 草稿

  async saveDraft(userId: string, answerId: string, input: { answer?: unknown }) {
    const answer = await this.requireAnswer(userId, answerId);
    const text = String(input.answer ?? '');
    const m = countMetrics(text);
    const rows = await this.t(userId).updatePracticeAnswer(answerId, {
      answer: text,
      isDraft: true,
      wordCount: m.words,
      paraCount: m.paras,
    });
    return rows[0];
  }

  async submitFirstAnswer(userId: string, questionId: string, input: { answer?: unknown }) {
    const question = await this.requireQuestion(userId, questionId);
    const text = String(input.answer ?? '').trim();
    if (!text) throw new BadRequestException('回答不能为空');

    const existing = await this.t(userId).listPracticeAnswers(questionId);
    let answer = existing.find((a: any) => a.turn === 0);
    const m = countMetrics(text);
    if (answer) {
      const rows = await this.t(userId).updatePracticeAnswer(answer.id, {
        answer: text,
        isDraft: false,
        wordCount: m.words,
        paraCount: m.paras,
        submittedAt: new Date(),
      });
      answer = rows[0];
    } else {
      const rows = await this.t(userId).createPracticeAnswer({
        id: newId('pa'),
        sessionId: question.sessionId,
        questionId,
        turn: 0,
        prompt: question.question,
        answer: text,
        isDraft: false,
        wordCount: m.words,
        paraCount: m.paras,
        submittedAt: new Date(),
      });
      answer = rows[0];
    }

    const scored = await this.scoreAnswerInternal(userId, answer, question);
    return { answer, ...scored };
  }

  async submitAnswer(userId: string, answerId: string, input: { answer?: unknown }) {
    const answer = await this.requireAnswer(userId, answerId);
    const text = input.answer !== undefined ? String(input.answer).trim() : String(answer.answer || '').trim();
    if (!text) throw new BadRequestException('回答不能为空');
    const m = countMetrics(text);
    const rows = await this.t(userId).updatePracticeAnswer(answerId, {
      answer: text,
      isDraft: false,
      wordCount: m.words,
      paraCount: m.paras,
      submittedAt: new Date(),
    });
    return rows[0];
  }

  // ---------------------------------------------------------- 追问

  async generateFollowUp(userId: string, questionId: string, input: { answerId?: unknown }) {
    const question = await this.requireQuestion(userId, questionId);
    const answerId = String(input.answerId ?? '').trim();
    if (!answerId) throw new BadRequestException('answerId 必填');
    const prevAnswer = await this.requireAnswer(userId, answerId);
    if (prevAnswer.questionId !== questionId) throw new BadRequestException('answerId 与题目不匹配');

    const maxFollowUps = question.maxFollowUps || 2;
    const nextTurn = (prevAnswer.turn ?? 0) + 1;
    if (nextTurn > maxFollowUps) {
      return { enough: true, answer: null, aiUsed: false, model: null, degraded: false };
    }

    let followUp = '';
    let target = '';
    let enough = false;
    let aiUsed = false;
    let model: string | null = null;

    try {
      const res = await this.ai.complete(userId, {
        messages: buildFollowUpMessages({
          question: question.question,
          answerText: prevAnswer.answer,
          turn: prevAnswer.turn ?? 0,
          maxFollowUps,
        }),
        temperature: 0.5,
        response_format: { type: 'json_object' },
      });
      const got = parseJsonLoose<{ followUp: string; target: string; enough: boolean }>(res.text);
      if (got && typeof got.followUp === 'string' && got.followUp.trim()) {
        followUp = got.followUp.trim();
        target = String(got.target || '');
        enough = !!got.enough;
        aiUsed = true;
        model = res.model;
      }
    } catch (e) {
      if (e instanceof AiProxyError && e.status === 400) throw e;
      aiUsed = false;
    }

    if (!aiUsed) {
      followUp = fallbackFollowUp(prevAnswer.answer);
      target = '补 STAR 缺项';
      enough = false;
    }

    const rows = await this.t(userId).createPracticeAnswer({
      id: newId('pa'),
      sessionId: question.sessionId,
      questionId,
      turn: nextTurn,
      prompt: followUp,
      answer: '',
      isDraft: true,
      wordCount: 0,
      paraCount: 0,
      submittedAt: null,
    });
    await this.bumpUsage(userId, question.sessionId, model, aiUsed);
    return { answer: rows[0], enough, target, aiUsed, model, degraded: !aiUsed };
  }

  // ---------------------------------------------------------- 评分 / 范例

  private async scoreAnswerInternal(userId: string, answer: any, question: any) {
    const evId = newId('pe');
    try {
      const res = await this.ai.complete(userId, {
        messages: buildScoreMessages({
          question: question.question,
          answerText: answer.answer,
          rubric: RUBRIC_DIMENSIONS,
          rubricVersion: RUBRIC_VERSION,
        }),
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      });
      const parsed = parseJsonLoose<PracticeScore>(res.text);
      const score = parsed ? normalizeScore(parsed) : null;
      await this.bumpUsage(userId, answer.sessionId, res.model, true);
      if (score) {
        const rows = await this.t(userId).createPracticeEvaluation({
          id: evId,
          answerId: answer.id,
          questionId: question.id,
          source: 'ai',
          status: 'generated',
          rubricVersion: RUBRIC_VERSION,
          promptVersion: PROMPT_VERSION,
          modelId: res.model,
          dimensions: score.dimensions,
          strengths: score.strengths,
          actions: score.actions,
          sampleAnswer: score.sampleAnswer,
          summary: score.summary,
          includeInProfile: true,
        });
        return { evaluation: rows[0], aiUsed: true, model: res.model, degraded: false };
      }
      // 解析失败：答案保留，标记 not_generated，不写画像
      const rows = await this.t(userId).createPracticeEvaluation({
        id: evId,
        answerId: answer.id,
        questionId: question.id,
        source: 'ai',
        status: 'not_generated',
        rubricVersion: RUBRIC_VERSION,
        promptVersion: PROMPT_VERSION,
        modelId: res.model,
        dimensions: [],
        strengths: [],
        actions: [],
        includeInProfile: false,
      });
      return { evaluation: rows[0], aiUsed: true, model: res.model, degraded: true, notGenerated: true };
    } catch (e) {
      if (e instanceof AiProxyError && e.status === 400) throw e; // 未配置 → 400，前端走自评降级
      // 上游失败/超时 → pending_retry，可重试，不写画像
      const rows = await this.t(userId).createPracticeEvaluation({
        id: evId,
        answerId: answer.id,
        questionId: question.id,
        source: 'ai',
        status: 'pending_retry',
        rubricVersion: RUBRIC_VERSION,
        promptVersion: PROMPT_VERSION,
        modelId: null,
        dimensions: [],
        strengths: [],
        actions: [],
        includeInProfile: false,
      });
      return { evaluation: rows[0], aiUsed: false, model: null, degraded: true, pendingRetry: true };
    }
  }

  async evaluateAnswer(userId: string, answerId: string) {
    const answer = await this.requireAnswer(userId, answerId);
    const question = await this.requireQuestion(userId, answer.questionId);
    return this.scoreAnswerInternal(userId, answer, question);
  }

  async selfEvaluate(userId: string, answerId: string, input: { dimensions?: unknown }) {
    const answer = await this.requireAnswer(userId, answerId);
    const dims = normalizeSelfScore(input.dimensions);
    if (!dims) throw new BadRequestException('自评维度必须是含 dimension(D1..D6) 与 level(1..4) 的数组');
    const rows = await this.t(userId).createPracticeEvaluation({
      id: newId('pe'),
      answerId,
      questionId: answer.questionId,
      source: 'self',
      status: 'generated',
      rubricVersion: RUBRIC_VERSION,
      promptVersion: PROMPT_VERSION,
      modelId: null,
      dimensions: dims,
      strengths: [],
      actions: [],
      includeInProfile: false,
    });
    return rows[0];
  }

  async sampleAnswer(userId: string, answerId: string) {
    const answer = await this.requireAnswer(userId, answerId);
    const question = await this.requireQuestion(userId, answer.questionId);
    const session = await this.requireSession(userId, answer.sessionId);
    const resumeText = await this.resumeTextOf(userId, session.resumeId);
    const jdText = String(obj(session.goal).jdText || '');

    let result: { sampleAnswer: string; basedOn: string } = { sampleAnswer: '', basedOn: 'generic' };
    let aiUsed = false;
    let model: string | null = null;

    try {
      const res = await this.ai.complete(userId, {
        messages: buildSampleAnswerMessages({ question: question.question, resumeText, jdText }),
        temperature: 0.6,
        response_format: { type: 'json_object' },
      });
      const got = parseJsonLoose<{ sampleAnswer: string; basedOn: string }>(res.text);
      if (got && typeof got.sampleAnswer === 'string' && got.sampleAnswer.trim()) {
        result = {
          sampleAnswer: got.sampleAnswer.trim(),
          basedOn: got.basedOn === 'resume' ? 'resume' : 'generic',
        };
        aiUsed = true;
        model = res.model;
      }
    } catch (e) {
      if (e instanceof AiProxyError && e.status === 400) throw e;
      aiUsed = false;
    }

    if (!aiUsed) result = fallbackSampleAnswer(question.question);
    await this.bumpUsage(userId, answer.sessionId, model, aiUsed);
    return { ...result, aiUsed, model, degraded: !aiUsed };
  }

  // ---------------------------------------------------------- 重练 / 沉淀

  async retryQuestion(userId: string, questionId: string) {
    const question = await this.requireQuestion(userId, questionId);
    const oldSession = await this.requireSession(userId, question.sessionId);
    const goal = obj(oldSession.goal);

    const sessionRows = await this.t(userId).createPracticeSession({
      id: newId('ps'),
      status: 'active',
      applicationId: oldSession.applicationId,
      resumeId: oldSession.resumeId,
      goal: { ...goal, questionSource: 'retry' },
      currentQuestionOrder: 0,
      usage: {},
      startedAt: new Date(),
      completedAt: null,
    });
    const newSession = sessionRows[0];

    const qid = newId('pq');
    const qRows = await this.t(userId).createPracticeQuestion({
      id: qid,
      sessionId: newSession.id,
      order: 0,
      questionKey: question.questionKey, // 同题稳定键：跨会话共享
      question: question.question,
      type: question.type,
      dimension: question.dimension,
      difficulty: question.difficulty,
      basis: question.basis,
      maxFollowUps: question.maxFollowUps,
      skipped: false,
      regeneratedFrom: question.id,
      weaknessId: question.weaknessId,
    });
    const newQuestion = qRows[0];
    const aRows = await this.t(userId).createPracticeAnswer({
      id: newId('pa'),
      sessionId: newSession.id,
      questionId: qid,
      turn: 0,
      prompt: question.question,
      answer: '',
      isDraft: true,
      wordCount: 0,
      paraCount: 0,
      submittedAt: null,
    });

    return { session: newSession, question: { ...newQuestion, answers: [aRows[0]] } };
  }

  async settleSession(userId: string, sessionId: string) {
    const session = await this.requireSession(userId, sessionId);
    const answers = await this.t(userId).listPracticeAnswersForSession(sessionId);
    const sessionEvals: any[] = [];
    for (const a of answers) {
      for (const e of await this.t(userId).listPracticeEvaluations(a.id)) {
        if (e.source === 'ai' && e.status === 'generated' && e.includeInProfile) sessionEvals.push(e);
      }
    }

    const sessionRows = await this.t(userId).updatePracticeSession(sessionId, {
      status: 'completed',
      completedAt: new Date(),
    });

    const allEvals = (await this.t(userId).listAllPracticeEvaluations()).filter(
      (e: any) => e.source === 'ai' && e.status === 'generated' && e.includeInProfile
    );
    const weaknesses = await this.rebuildDimensionWeaknesses(userId, allEvals);
    const profile = aggregateProfile(allEvals);

    return { session: sessionRows[0], weaknesses, profile };
  }

  private async rebuildDimensionWeaknesses(userId: string, aiEvals: any[]) {
    const byDim = new Map<DimensionCode, any[]>();
    for (const e of aiEvals) {
      const dims = Array.isArray(e.dimensions) ? e.dimensions : [];
      for (const d of dims) {
        if (isDimensionCode(d?.dimension)) {
          const list = byDim.get(d.dimension) || [];
          list.push(e);
          byDim.set(d.dimension, list);
        }
      }
    }

    const out: any[] = [];
    const existing = await this.t(userId).listPracticeWeaknesses();
    for (const code of DIMENSION_CODES) {
      const rows = (byDim.get(code) || [])
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 3);
      const lowCount = rows.filter((e) => {
        const dim = (e.dimensions as any[]).find((d) => d?.dimension === code);
        return dim && dim.level <= 2;
      }).length;
      if (lowCount >= 2) {
        const found = existing.find(
          (w: any) => w.source === 'dimension' && w.dimension === code && w.status !== 'resolved'
        );
        if (found) {
          out.push(found);
        } else {
          const name = RUBRIC_DIMENSIONS.find((d) => d.code === code)?.name || code;
          const rows2 = await this.t(userId).createPracticeWeakness({
            id: newId('pw'),
            source: 'dimension',
            dimension: code,
            reason: `最近 3 次 AI 评分中「${name}」有 ${lowCount} 次 ≤2 档（规则：≥2 次判为弱项）`,
            status: 'pending',
          });
          out.push(rows2[0]);
        }
      }
    }
    return out;
  }

  async exportKb(
    userId: string,
    sessionId: string,
    input: { title?: unknown; category?: unknown; tags?: unknown }
  ) {
    const session = await this.requireSession(userId, sessionId);
    const title = String(input.title ?? '').trim();
    if (!title) throw new BadRequestException('title 必填');

    const questions = await this.t(userId).listPracticeQuestions(sessionId);
    const answers = await this.t(userId).listPracticeAnswersForSession(sessionId);
    const lines: string[] = [];
    for (const q of questions) {
      lines.push('## ' + q.question);
      const qAnswers = answers.filter((a: any) => a.questionId === q.id && !a.isDraft);
      for (const a of qAnswers) {
        const head = a.turn === 0 ? '我的回答' : `追问 ${a.turn}：${a.prompt}`;
        lines.push(`${head}\n${a.answer}`);
        const evals = await this.t(userId).listPracticeEvaluations(a.id);
        const ai = evals.find((e: any) => e.source === 'ai' && e.status === 'generated');
        if (ai?.summary) lines.push('AI 点评：' + ai.summary);
        if (ai?.actions?.length) lines.push('改进建议：' + ai.actions.join('；'));
      }
    }
    const content = lines.join('\n\n') + '\n\n（来源练习会话 ' + session.id + '）';
    const tags = [...this.strArr(input.tags), 'practice-session:' + session.id];
    const rows = await this.t(userId).createKb({
      id: newId('kb'),
      title,
      category: this.optStr(input.category),
      tags,
      content,
    });
    return rows[0];
  }

  // ---------------------------------------------------------- 弱项

  listWeaknesses(userId: string) {
    return this.t(userId).listPracticeWeaknesses();
  }

  async createWeakness(
    userId: string,
    input: {
      source?: unknown;
      dimension?: unknown;
      questionId?: unknown;
      interviewNoteId?: unknown;
      reason?: unknown;
    }
  ) {
    const source = input.source;
    if (!['dimension', 'question', 'interview_note'].includes(source as string)) {
      throw new BadRequestException('source 只能是 dimension / question / interview_note');
    }
    const reason = String(input.reason ?? '').trim();
    if (!reason) throw new BadRequestException('reason 必填');

    let dimension: string | null = null;
    if (source === 'dimension') {
      if (!isDimensionCode(input.dimension)) throw new BadRequestException('来源为维度时 dimension 必填（D1..D6）');
      dimension = input.dimension as string;
    } else {
      dimension = this.optStr(input.dimension);
    }

    const questionId = this.optId(input.questionId);
    if (source === 'question') {
      if (!questionId) throw new BadRequestException('来源为题时 questionId 必填');
      await this.requireQuestion(userId, questionId);
    }
    const interviewNoteId = this.optId(input.interviewNoteId);
    if (source === 'interview_note') {
      if (!interviewNoteId) throw new BadRequestException('来源为复盘时 interviewNoteId 必填');
      const notes = await this.t(userId).getInterviewNote(interviewNoteId);
      if (!notes.length) throw new NotFoundException('面试记录不存在');
    }

    const rows = await this.t(userId).createPracticeWeakness({
      id: newId('pw'),
      source: source as 'dimension' | 'question' | 'interview_note',
      dimension,
      questionId,
      interviewNoteId,
      reason,
      status: 'pending',
    });
    return rows[0];
  }

  async updateWeaknessStatus(userId: string, id: string, input: { status?: unknown }) {
    const weakness = await this.requireWeakness(userId, id);
    const status = input.status;
    if (!['pending', 'practiced', 'resolved'].includes(status as string)) {
      throw new BadRequestException('status 只能是 pending / practiced / resolved');
    }
    const rows = await this.t(userId).updatePracticeWeakness(id, {
      status: status as any,
      ...(status === 'practiced' ? { lastPracticeAt: new Date() } : {}),
    });
    return rows[0];
  }

  // ---------------------------------------------------------- 成长

  async growth(
    userId: string,
    query: { rubricVersion?: string; from?: string; to?: string }
  ) {
    const evals = (await this.t(userId).listAllPracticeEvaluations())
      .filter((e: any) => e.source === 'ai' && e.status === 'generated' && e.includeInProfile)
      .filter((e: any) => !query.rubricVersion || e.rubricVersion === query.rubricVersion)
      .filter((e: any) => {
        const at = new Date(e.createdAt).getTime();
        const from = query.from ? new Date(query.from).getTime() : null;
        const to = query.to ? new Date(query.to).getTime() : null;
        return (!from || at >= from) && (!to || at <= to);
      });

    const sessions = await this.t(userId).listPracticeSessions();
    const questions = await this.t(userId).listAllPracticeQuestions();

    // 同题对比：question_key 出现 ≥2 次的题目链
    const byKey = new Map<string, any[]>();
    for (const q of questions) {
      const list = byKey.get(q.questionKey) || [];
      list.push(q);
      byKey.set(q.questionKey, list);
    }
    const sameQuestion: any[] = [];
    for (const [key, group] of byKey) {
      if (group.length < 2) continue;
      const attempts: any[] = [];
      for (const q of group) {
        const qAnswers = await this.t(userId).listPracticeAnswers(q.id);
        const first = qAnswers.find((a: any) => a.turn === 0 && !a.isDraft);
        const levels: any[] = [];
        if (first) {
          const evs = await this.t(userId).listPracticeEvaluations(first.id);
          const ai = evs.find((e: any) => e.source === 'ai' && e.status === 'generated');
          if (ai) levels.push(...(Array.isArray(ai.dimensions) ? ai.dimensions : []));
        }
        attempts.push({ questionId: q.id, answer: first?.answer || '', submittedAt: first?.submittedAt || null, levels });
      }
      sameQuestion.push({ questionKey: key, question: group[0].question, attempts });
    }

    return {
      rubricVersions: [...new Set(evals.map((e: any) => e.rubricVersion))],
      profile: aggregateProfile(evals),
      trend: trendSeries(evals),
      radar: radarView(evals),
      calendar: calendarView(sessions),
      milestones: milestonesView(evals, questions, sessions),
      sameQuestion,
    };
  }
}

// ------------------------------------------------------------ 纯函数助手

function countMetrics(text: string): { words: number; paras: number } {
  const t = String(text || '');
  const trimmed = t.trim();
  return {
    words: trimmed ? trimmed.length : 0,
    paras: trimmed ? t.split(/\n+/).filter((p) => p.trim()).length : 0,
  };
}

function normalizeQuestion(raw: unknown): QuestionDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const question = String(r.question ?? '').trim();
  if (!question) return null;
  const type = QUESTION_TYPES.includes(r.type as QuestionType) ? (r.type as QuestionType) : 'behavioral';
  const difficulty = DIFFICULTIES.includes(r.difficulty as any) ? (r.difficulty as 'easy' | 'standard' | 'hard') : 'standard';
  const basisRaw = obj(r.basis);
  const basis: Json = {
    source: String(basisRaw.source || 'generic'),
    excerpt: String(basisRaw.excerpt || '').slice(0, 500),
  };
  return { question, type, dimension: pickDimension(r.dimension), difficulty, basis };
}

function fallbackFollowUp(answerText: string): string {
  const a = String(answerText || '').trim();
  if (!a) return '能再具体说说你个人在这件事里具体做了什么吗？';
  return '你提到了「' + a.slice(0, 60) + '」，能补充一下你个人具体的动作和可量化的结果吗？';
}

function aggregateProfile(evals: any[]): Record<string, { latest: number | null; count: number; history: any[] }> {
  const profile: Record<string, { latest: number | null; count: number; history: any[] }> = {};
  for (const code of DIMENSION_CODES) {
    const history: any[] = [];
    for (const e of evals) {
      const dim = (Array.isArray(e.dimensions) ? e.dimensions : []).find((d: any) => d?.dimension === code);
      if (dim && typeof dim.level === 'number') {
        history.push({ level: dim.level, at: e.createdAt, rubricVersion: e.rubricVersion });
      }
    }
    history.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    profile[code] = {
      latest: history.length ? history[history.length - 1].level : null,
      count: history.length,
      history,
    };
  }
  return profile;
}

function trendSeries(evals: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const code of DIMENSION_CODES) {
    out[code] = [];
  }
  const sorted = [...evals].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  for (const e of sorted) {
    for (const dim of Array.isArray(e.dimensions) ? e.dimensions : []) {
      if (isDimensionCode(dim?.dimension) && typeof dim.level === 'number') {
        out[dim.dimension].push({ level: dim.level, at: e.createdAt });
      }
    }
  }
  return out;
}

function radarView(evals: any[]): { first: Record<string, number | null>; recent: Record<string, number | null> } {
  const first: Record<string, number | null> = {};
  const recent: Record<string, number | null> = {};
  for (const code of DIMENSION_CODES) {
    const series: any[] = [];
    for (const e of evals) {
      const dim = (Array.isArray(e.dimensions) ? e.dimensions : []).find((d: any) => d?.dimension === code);
      if (dim && typeof dim.level === 'number') series.push(dim.level);
    }
    first[code] = series.length ? series[0] : null;
    recent[code] = series.length ? series[series.length - 1] : null;
  }
  return { first, recent };
}

function calendarView(sessions: any[]): { days: string[]; totalDays: number } {
  const days = new Set<string>();
  for (const s of sessions) {
    const d = s.startedAt || s.createdAt;
    if (d) days.add(new Date(d).toISOString().slice(0, 10));
  }
  return { days: [...days].sort(), totalDays: days.size };
}

function milestonesView(evals: any[], questions: any[], sessions: any[]): string[] {
  const out: string[] = [];
  const completed = sessions.filter((s: any) => s.status === 'completed').length;
  if (completed >= 1) out.push(`已完成 ${completed} 场练习`);
  if (evals.length >= 5) out.push(`累计 ${evals.length} 次 AI 评分`);
  const totalQuestions = questions.length;
  if (totalQuestions >= 10) out.push(`累计练习 ${totalQuestions} 题`);
  // 单维连续 ≥3 档
  const streak: Record<string, number> = {};
  const sorted = [...evals].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  for (const e of sorted) {
    for (const dim of Array.isArray(e.dimensions) ? e.dimensions : []) {
      if (isDimensionCode(dim?.dimension) && typeof dim.level === 'number') {
        streak[dim.dimension] = dim.level >= 3 ? (streak[dim.dimension] || 0) + 1 : 0;
      }
    }
  }
  for (const code of DIMENSION_CODES) {
    if ((streak[code] || 0) >= 3) {
      const name = RUBRIC_DIMENSIONS.find((d) => d.code === code)?.name || code;
      out.push(`${name} 连续 ${streak[code]} 次 ≥3 档`);
    }
  }
  return out;
}
