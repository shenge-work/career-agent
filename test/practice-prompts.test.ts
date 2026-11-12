import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { pickLocalQuestions } from '../src/server/practice/local-question-bank';
import {
  buildFollowUpMessages,
  buildQuestionsMessages,
  buildSampleAnswerMessages,
  buildScoreMessages,
  fallbackSampleAnswer,
  flattenResume,
  parseJsonLoose,
  pickDimension,
} from '../src/server/practice/prompts';
import {
  DIMENSION_CODES,
  isDimensionCode,
  normalizeScore,
  normalizeSelfScore,
  RUBRIC_DIMENSIONS,
  RUBRIC_VERSION,
} from '../src/server/practice/rubric';

/** 构造一条合法评分（6 维齐、reason/evidence 非空、actions ≥1）。 */
function validScore(level = 3) {
  return {
    dimensions: DIMENSION_CODES.map((dimension) => ({
      dimension,
      reason: '档位理由-' + dimension,
      level,
      evidence: '原文证据-' + dimension,
    })),
    strengths: ['行动具体，有量化结果'],
    actions: ['补充一句可复现的量化指标'],
    sampleAnswer: '示范，非标准答案：可以这样说……',
    summary: '整体结构完整。',
  };
}

describe('N14 · rubric 白名单校验（normalizeScore / normalizeSelfScore）', () => {
  it('合法评分归一化后 6 维齐、字段顺序固定为 reason 先于 level', () => {
    const out = normalizeScore(validScore(4));
    expect(out).not.toBeNull();
    expect(out!.dimensions).toHaveLength(6);
    for (const d of out!.dimensions) {
      expect(Object.keys(d)).toEqual(['dimension', 'reason', 'level', 'evidence']);
      expect(isDimensionCode(d.dimension)).toBe(true);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.evidence.length).toBeGreaterThan(0);
    }
    expect(out!.actions.length).toBeGreaterThan(0);
  });

  it('dimensions 数量不是 6 → null（不产低分、不写画像）', () => {
    const raw = { ...validScore(), dimensions: validScore().dimensions.slice(0, 5) };
    expect(normalizeScore(raw)).toBeNull();
    expect(normalizeScore({ ...validScore(), dimensions: [] })).toBeNull();
  });

  it('维度重复 / 非法维度 / 缺维度 → null', () => {
    const dup = validScore();
    dup.dimensions[5] = { ...dup.dimensions[0] }; // D1 重复
    expect(normalizeScore(dup)).toBeNull();

    const bad = validScore();
    bad.dimensions[0] = { ...bad.dimensions[0], dimension: 'D9' };
    expect(normalizeScore(bad)).toBeNull();
  });

  it('level 越界 / 非整数 → null', () => {
    const low = validScore();
    low.dimensions[0] = { ...low.dimensions[0], level: 0 };
    expect(normalizeScore(low)).toBeNull();

    const high = validScore();
    high.dimensions[0] = { ...high.dimensions[0], level: 5 };
    expect(normalizeScore(high)).toBeNull();

    const float = validScore();
    (float.dimensions[0] as any).level = 2.5;
    expect(normalizeScore(float)).toBeNull();
  });

  it('reason / evidence 为空 → null', () => {
    const noReason = validScore();
    noReason.dimensions[0] = { ...noReason.dimensions[0], reason: '   ' };
    expect(normalizeScore(noReason)).toBeNull();

    const noEvidence = validScore();
    noEvidence.dimensions[1] = { ...noEvidence.dimensions[1], evidence: '' };
    expect(normalizeScore(noEvidence)).toBeNull();
  });

  it('actions 为空 → null；strengths/sampleAnswer/summary 可为空', () => {
    expect(normalizeScore({ ...validScore(), actions: [] })).toBeNull();
    expect(normalizeScore({ ...validScore(), actions: [' '] })).toBeNull();
    const noExtras = normalizeScore({ ...validScore(), strengths: [], sampleAnswer: '', summary: '' });
    expect(noExtras).not.toBeNull();
  });

  it('非对象 / 数组输入 → null', () => {
    expect(normalizeScore(null)).toBeNull();
    expect(normalizeScore(undefined)).toBeNull();
    expect(normalizeScore('x')).toBeNull();
    expect(normalizeScore([1, 2])).toBeNull();
  });

  it('normalizeSelfScore 只收 dimension+level，拒绝重复 / 非法 / 空数组', () => {
    const ok = normalizeSelfScore([
      { dimension: 'D1', level: 2 },
      { dimension: 'D3', level: 4 },
    ]);
    expect(ok).toHaveLength(2);
    expect(ok![0]).toEqual({ dimension: 'D1', level: 2 });

    expect(normalizeSelfScore([])).toBeNull();
    expect(normalizeSelfScore('x')).toBeNull();
    expect(
      normalizeSelfScore([
        { dimension: 'D1', level: 2 },
        { dimension: 'D1', level: 3 },
      ])
    ).toBeNull();
    expect(normalizeSelfScore([{ dimension: 'D9', level: 2 }])).toBeNull();
    expect(normalizeSelfScore([{ dimension: 'D1', level: 9 }])).toBeNull();
  });

  it('isDimensionCode 只认 D1..D6', () => {
    expect(isDimensionCode('D1')).toBe(true);
    expect(isDimensionCode('D6')).toBe(true);
    expect(isDimensionCode('D0')).toBe(false);
    expect(isDimensionCode('d1')).toBe(false);
    expect(isDimensionCode(null)).toBe(false);
    expect(isDimensionCode(1)).toBe(false);
  });
});

describe('N14 · 本地题库纯函数', () => {
  it('未指定条件时确定性返回恰好 count 道', () => {
    const out = pickLocalQuestions({}, 5);
    expect(out).toHaveLength(5);
    expect(out[0].question.length).toBeGreaterThan(0);
  });

  it('type / difficulty 过滤命中不足时循环补齐', () => {
    const hr = pickLocalQuestions({ questionType: 'hr' }, 6);
    expect(hr).toHaveLength(6);
    expect(hr.every((q) => q.type === 'hr')).toBe(true);

    const hard = pickLocalQuestions({ difficulty: 'hard' }, 4);
    expect(hard).toHaveLength(4);
    expect(hard.every((q) => q.difficulty === 'hard')).toBe(true);
  });

  it('count 边界被 clamp 到 1..10（0 视为未提供，回落默认 3）', () => {
    expect(pickLocalQuestions({}, -3)).toHaveLength(1);
    expect(pickLocalQuestions({}, 999)).toHaveLength(10);
    expect(pickLocalQuestions({}, 0)).toHaveLength(3);
  });
});

describe('N14 · prompt 纯函数（事实护栏 + 结构化契约）', () => {
  it('出题 prompt 注入简历/JD，且系统 prompt 含事实护栏', () => {
    const msgs = buildQuestionsMessages({
      jdText: 'JD：高级前端',
      resumeText: '简历：张三，React 三年',
      questionType: 'project',
      difficulty: 'hard',
      questionCount: 3,
      weaknessContext: '',
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('不得编造');
    expect(msgs[1].content).toContain('JD：高级前端');
    expect(msgs[1].content).toContain('简历：张三');
  });

  it('追问 prompt 引用上一轮回答与层数', () => {
    const msgs = buildFollowUpMessages({
      question: '讲一个项目',
      answerText: '我们做了缓存优化',
      turn: 1,
      maxFollowUps: 2,
    });
    expect(msgs[1].content).toContain('我们做了缓存优化');
    expect(msgs[1].content).toContain('已追问层数：1 / 2');
  });

  it('评分 prompt 注入 rubric 与版本，并强调 reason 先于 level', () => {
    const msgs = buildScoreMessages({
      question: '题干',
      answerText: '答案',
      rubric: RUBRIC_DIMENSIONS,
      rubricVersion: RUBRIC_VERSION,
    });
    expect(msgs[0].content).toContain('Rubric 执行器');
    expect(msgs[0].content).toContain('reason');
    expect(msgs[1].content).toContain('评分 rubric 版本：' + RUBRIC_VERSION);
    expect(msgs[1].content).toContain('D1');
    expect(msgs[1].content).toContain('D6');
  });

  it('范例答案 prompt 含事实护栏与「示范，非标准答案」', () => {
    const msgs = buildSampleAnswerMessages({
      question: '讲一个项目',
      resumeText: '简历：李四',
      jdText: 'JD：后端',
    });
    expect(msgs[0].content).toContain('不得编造');
    expect(msgs[0].content).toContain('示范，非标准答案');
    expect(msgs[1].content).toContain('简历：李四');
  });

  it('fallbackSampleAnswer 返回通用 STAR 骨架且不编造经历', () => {
    const out = fallbackSampleAnswer('讲一个项目');
    expect(out.basedOn).toBe('generic');
    expect(out.sampleAnswer).toContain('示范，非标准答案');
    expect(out.sampleAnswer).toContain('STAR');
  });

  it('flattenResume 扁平化数据并跳过 id/type/logo/pageBreak 键', () => {
    const text = flattenResume({
      data: {
        name: '张三',
        id: 'skip-me',
        type: 'section',
        logo: 'http://x/logo.png',
        pageBreak: true,
        sections: [{ title: '经历', body: '负责缓存层' }],
      },
    });
    expect(text).toContain('张三');
    expect(text).toContain('经历');
    expect(text).toContain('负责缓存层');
    expect(text).not.toContain('skip-me');
    expect(text).not.toContain('http://x/logo.png');
  });

  it('parseJsonLoose 容忍 markdown 代码块与前后缀噪音，非法输入返回 null', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('前缀 {"a":3} 后缀')).toEqual({ a: 3 });
    expect(parseJsonLoose('不是 JSON')).toBeNull();
    expect(parseJsonLoose('')).toBeNull();
  });

  it('pickDimension 只认 D1..D6，其余返回 null', () => {
    expect(pickDimension('D3')).toBe('D3');
    expect(pickDimension('D9')).toBeNull();
    expect(pickDimension(null)).toBeNull();
  });
});
