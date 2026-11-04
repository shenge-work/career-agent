import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../tenant/tenant-db';
import { AiService, AiProxyError } from '../ai/ai.service';
import {
  buildGenPitchMessages,
  buildKbAskMessages,
  buildParseJdMessages,
  buildReviewInterviewMessages,
  fallbackKbAsk,
  fallbackParseJd,
  fallbackPitch,
  fallbackReviewInterview,
  flattenResume,
  parseJsonLoose,
  type InterviewReview,
  type KbAskAnswer,
  type ParsedJd,
} from './prompts';
import { analyze, extractTerms } from '../business/jd.service';

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

/**
 * Agent 编排层（N12 S1）：场景化动作，非通用对话。
 *
 * 每个动作有明确的输入/输出契约，system prompt 由服务端按场景组装，
 * 前端不直接拼 prompt（防注入 + 保质量）。所有大模型调用复用 AiService，
 * 用量统计 / Key 隔离 / SSRF 防护自动继承；未配置 AI 时走规则/模板降级。
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(TenantDb) private readonly tenant: TenantDb,
    private readonly ai: AiService
  ) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  private async requireApplication(userId: string, id: string) {
    const rows = await this.t(userId).getApplication(id);
    if (!rows.length) throw new NotFoundException('岗位不存在');
    return rows[0];
  }

  private async requireResume(userId: string, id: string) {
    const rows = await this.t(userId).getResume(id);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return rows[0];
  }

  private async jdTextOf(userId: string, application: any): Promise<string> {
    const payload = obj(application.payload);
    const fromPayload = payload.jdText;
    if (typeof fromPayload === 'string' && fromPayload.trim()) return fromPayload.trim();
    if (application.jdId) {
      const jds = await this.t(userId).getCompanyJd(application.jdId);
      const jd = jds[0];
      const jdPayload = jd ? obj(jd.payload) : {};
      const jdText = jdPayload.jdText ?? jdPayload.text ?? jdPayload.jd;
      if (typeof jdText === 'string' && jdText.trim()) return jdText.trim();
    }
    if (application.resumeId) {
      const resume = await this.requireResume(userId, application.resumeId);
      if (resume.jdText) return String(resume.jdText).trim();
    }
    return '';
  }

  /**
   * 动作 1：JD 结构化解析（规则 + 大模型混合）。
   *   · 规则层永远先跑（extractTerms + analyze），作为可解释基线；
   *   · 大模型做结构化抽取（JSON），只做补充不替代规则层结论；
   *   · AI 未配置 → 规则降级（fallbackParseJd），仍返回 keywords 与匹配结果。
   * 纯解析，不落库。
   */
  async parseJd(userId: string, input: { jdText?: unknown; resumeId?: unknown }) {
    const jdText = String(input.jdText ?? '').trim();
    if (!jdText) throw new BadRequestException('JD 内容不能为空');

    const ruleTerms = extractTerms(jdText);
    const ruleKeywords = ruleTerms.map((t) => t.term);

    let resume = null;
    let matchResult: ReturnType<typeof analyze> | null = null;
    if (input.resumeId) {
      resume = await this.requireResume(userId, String(input.resumeId));
      matchResult = analyze(resume.payload, jdText);
    }

    let parsed: ParsedJd | null = null;
    let aiUsed = false;
    let model: string | null = null;

    try {
      const res = await this.ai.complete(userId, {
        messages: buildParseJdMessages(jdText, ruleKeywords),
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      const got = parseJsonLoose<ParsedJd>(res.text);
      if (got) {
        parsed = normalizeParsedJd(got);
        aiUsed = true;
        model = res.model;
      }
    } catch (e) {
      // AI 未配置或调用失败 → 降级规则层，不阻断主流程（N12 §3.4）。
      if (e instanceof AiProxyError && e.status !== 400) {
        // 非「未配置」的失败也降级，但保留提示；400 直接走 fallback。
      }
      aiUsed = false;
      parsed = null;
    }

    if (!parsed) parsed = fallbackParseJd(jdText, ruleKeywords);

    return {
      jdText,
      parsed,
      aiUsed,
      model,
      degraded: !aiUsed,
      rule: {
        keywords: ruleKeywords.slice(0, 40),
        termCount: ruleTerms.length,
        match: matchResult,
      },
    };
  }

  /**
   * 动作 2：生成投递话术（大模型 + 模板降级）。
   *   · 读岗位（applications）聚合根，拿 JD + 关联简历 + 公司；
   *   · 大模型基于真实简历片段生成 greeting / coverLetter；
   *   · 生成结果写回 applications.payload.pitch，与岗位绑定、可重生成。
   */
  async genPitch(userId: string, applicationId: string, input: { jdText?: unknown }) {
    const app = await this.requireApplication(userId, applicationId);
    const payload = obj(app.payload);

    // JD 优先用本次传入，其次落库的 jdText，再退到关联 JD / 简历。
    let jdText = String(input.jdText ?? '').trim();
    if (!jdText) jdText = await this.jdTextOf(userId, app);
    if (!jdText) throw new BadRequestException('缺少 JD 文本：请先填写岗位的 JD，或本次传入 jdText');

    // 简历：优先岗位绑定的 resumeId，否则取主简历。缺失不阻断（降级路径无需简历）。
    let resume = null;
    if (app.resumeId) resume = await this.requireResume(userId, app.resumeId);
    if (!resume) {
      const all = await this.t(userId).listResumes();
      resume = all.find((r: any) => r.isMaster) || all[0] || null;
    }

    const ruleTerms = extractTerms(jdText);
    const ruleKeywords = ruleTerms.map((t) => t.term);

    // 复用已落库的 JD 结构化结果（若有），否则本次即时解析。
    let parsed: ParsedJd | null = (payload.jdParsed as ParsedJd) || null;
    if (!parsed) parsed = fallbackParseJd(jdText, ruleKeywords);

    const company = app.companyId
      ? await this.t(userId).getCompany(app.companyId).then((rows) => rows[0]?.name || null)
      : null;

    const snippet = {
      title: String(resume?.title || '简历'),
      text: resume ? flattenResume(resume.payload as Json) : '',
    };

    let result: { greeting: string; coverLetter: string; fallback?: boolean } | null = null;
    let aiUsed = false;
    let model: string | null = null;

    try {
      const res = await this.ai.complete(userId, {
        messages: buildGenPitchMessages({ jdText, jdParsed: parsed, resume: snippet, company }),
        temperature: 0.6,
        response_format: { type: 'json_object' },
      });
      const got = parseJsonLoose<{ greeting: string; coverLetter: string }>(res.text);
      if (got && (typeof got.greeting === 'string' || typeof got.coverLetter === 'string')) {
        result = {
          greeting: String(got.greeting || '').trim(),
          coverLetter: String(got.coverLetter || '').trim(),
        };
        aiUsed = true;
        model = res.model;
      }
    } catch {
      aiUsed = false;
      result = null;
    }

    if (!result) result = fallbackPitch({ jdParsed: parsed, ruleKeywords });

    const pitch = {
      greeting: result.greeting,
      coverLetter: result.coverLetter,
      generatedAt: Date.now(),
      model: model ?? null,
      basedOn: 'resume',
      degraded: !aiUsed,
    };

    // 写回岗位 payload（保留其它字段，只合并 pitch）。
    const nextPayload = { ...payload, pitch };
    const rows = await this.t(userId).updateApplication(applicationId, { payload: nextPayload });
    if (!rows.length) throw new NotFoundException('岗位不存在');

    return { ...rows[0], pitch };
  }

  /**
   * 动作 3：面试复盘（大模型 + 模板降级）。
   *   · 读 interview_notes 记录（原始记录 transcript），大模型生成结构化复盘；
   *   · 复盘结果写回 interview_notes.payload.aiReview，与面试记录绑定、可重生成。
   */
  async reviewInterview(userId: string, noteId: string) {
    const rows = await this.t(userId).getInterviewNote(noteId);
    if (!rows.length) throw new NotFoundException('面试记录不存在');
    const note = rows[0];
    const payload = obj(note.payload);

    const transcript =
      (typeof payload.transcript === 'string' && payload.transcript) ||
      (typeof payload.questions === 'string' && payload.questions) ||
      (typeof payload.notes === 'string' && payload.notes) ||
      '';
    if (!transcript.trim()) {
      throw new BadRequestException('缺少面试记录内容：请先在复盘里填写问题/回答/反思（transcript）');
    }

    let review: InterviewReview | null = null;
    let aiUsed = false;
    let model: string | null = null;

    try {
      const res = await this.ai.complete(userId, {
        messages: buildReviewInterviewMessages({
          company: note.company,
          position: note.position,
          round: note.round,
          transcript,
        }),
        temperature: 0.4,
        response_format: { type: 'json_object' },
      });
      const got = parseJsonLoose<InterviewReview>(res.text);
      if (got && typeof got.summary === 'string') {
        review = normalizeReview(got);
        aiUsed = true;
        model = res.model;
      }
    } catch {
      aiUsed = false;
      review = null;
    }

    if (!review) review = fallbackReviewInterview({ company: note.company, position: note.position });

    const aiReview = {
      ...review,
      generatedAt: Date.now(),
      model: model ?? null,
      degraded: !aiUsed,
    };

    // 写回面试记录 payload（保留其它字段，只合并 aiReview）。
    const nextPayload = { ...payload, aiReview };
    const updated = await this.t(userId).updateInterviewNote(noteId, { payload: nextPayload });
    if (!updated.length) throw new NotFoundException('面试记录不存在');

    return { ...updated[0], aiReview };
  }

  /**
   * 动作 4：面经问答（本地检索 + 大模型 + 原文降级）。
   *   · 先用 TenantDb.searchKb 做本地关键词/全文检索（零外部依赖，N12 §5.1）；
   *   · 检索到的片段注入大模型，只基于用户自己的知识库作答；
   *   · AI 未配置 → 直接把命中的知识库原文拼出来（fallbackKbAsk）。
   */
  async kbAsk(userId: string, question: string) {
    const q = String(question ?? '').trim();
    if (!q) throw new BadRequestException('问题不能为空');

    const hits = await this.t(userId).searchKb(q, 6);
    const passages = hits.map((h) => ({
      title: h.title,
      category: h.category,
      content: h.content,
    }));

    let answer: KbAskAnswer | null = null;
    let aiUsed = false;
    let model: string | null = null;

    try {
      const res = await this.ai.complete(userId, {
        messages: buildKbAskMessages({ question: q, passages }),
        temperature: 0.4,
        response_format: { type: 'json_object' },
      });
      const got = parseJsonLoose<KbAskAnswer>(res.text);
      if (got && typeof got.answer === 'string') {
        answer = normalizeKbAsk(got);
        aiUsed = true;
        model = res.model;
      }
    } catch {
      aiUsed = false;
      answer = null;
    }

    if (!answer) answer = fallbackKbAsk({ question: q, passages });

    return {
      question: q,
      ...answer,
      aiUsed,
      model,
      degraded: !aiUsed,
      hitCount: hits.length,
    };
  }
}

/** 大模型返回的字段做白名单归一化，杜绝注入非法结构。 */
function normalizeParsedJd(raw: ParsedJd): ParsedJd {
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.slice(0, 60).map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    position: String(raw.position || '').trim().slice(0, 80) || '未识别岗位',
    company: typeof raw.company === 'string' ? raw.company.trim().slice(0, 80) : '',
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 500) : '',
    requirements: strArr(raw.requirements),
    preferred: strArr(raw.preferred),
    keywords: strArr(raw.keywords),
  };
}

/** 面试复盘结果白名单归一化。 */
function normalizeReview(raw: InterviewReview): InterviewReview {
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.slice(0, 60).map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    summary: String(raw.summary || '').trim().slice(0, 500),
    strengths: strArr(raw.strengths),
    weaknesses: strArr(raw.weaknesses),
    suggestions: strArr(raw.suggestions),
    verdict: typeof raw.verdict === 'string' ? raw.verdict.trim().slice(0, 200) : '',
  };
}

/** 面经问答结果白名单归一化。 */
function normalizeKbAsk(raw: KbAskAnswer): KbAskAnswer {
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.slice(0, 30).map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    answer: String(raw.answer || '').trim().slice(0, 4000),
    sources: strArr(raw.sources),
    grounded: Boolean(raw.grounded),
  };
}
