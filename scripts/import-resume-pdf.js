/**
 * 把资料库里的简历 PDF（陈培胜 · 5年 · 红杉系初创+金融头部AI工程主力）录入为一份简历，
 * 并把用户确认「都投这份简历」的 6 个岗位关联过去。
 *
 * 内容来源：https://www.workbuddy.cn/space/d/mFPiB33gkq7ahl0ZCQfH9K（kind=drive, pdf）
 * 版式参照：库里已有的主简历 payload（v8）——fonts / spacing / theme 直接复用，
 * 避免新简历因为缺省样式而在编辑器里错版。
 *
 * 用法：node scripts/import-resume-pdf.js <pdf 路径>
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.CA_BASE || 'http://127.0.0.1:3000';
const PDF_PATH = process.argv[2] || '/tmp/ca-resume.pdf';
const PDF_NAME = '陈培胜 · 5年 · 红杉系初创+金融头部AI工程主力.pdf';
const SOURCE_NODE = 'https://www.workbuddy.cn/space/d/mFPiB33gkq7ahl0ZCQfH9K';

let cookie = '';

async function http(method, p, body, isForm) {
  const headers = { Cookie: cookie };
  let payload;
  if (isForm) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const sp = (mb = 0, mt = 0) => ({ mb, mt });

/* ============================================================ 简历内容（据 PDF 原文） */

const SUMMARY = [
  {
    text:
      '**红杉系初创+金融头部AI主力**，擅长 **Agent 工程化、RAG 及评测治理、AI 网关、分布式 IM 网关**，把大模型能力从 Demo 推进到生产环境稳定运行；多套 Agent 系统 **0 → 1**——AI 金融投研工作台、AI 人脉搜索引擎、一站式营销 SaaS（云沙箱多租户）。',
    spacing: sp(0, 0),
  },
];

const CAREER = [
  {
    date: '2026.01 - 2026.07',
    role: 'AI 全栈开发工程师',
    company: '深圳进门财经科技股份有限公司　机构金融投研 SaaS',
    summary: '组织架构调整，团队缩编',
    spacing: sp(8, 0),
  },
  {
    date: '2024.03 - 2025.11',
    role: 'AI 全栈开发工程师 · 创始团队成员',
    company: '深圳指数引力科技有限公司　网红营销 SaaS（红杉投资）',
    summary: '',
    spacing: sp(8, 0),
  },
  {
    date: '2023.08 - 2024.01',
    role: 'Java 开发工程师',
    company: '深圳市房极客网络科技有限公司　房地产 SaaS',
    summary: '',
    spacing: sp(8, 0),
  },
  {
    date: '2023.07',
    role: 'Java 开发工程师',
    company: '深圳丰速科技有限公司　电商 SaaS（顺丰投资）',
    summary: '公司搬迁苏州，仅工作两周',
    spacing: sp(8, 0),
  },
  {
    date: '2021.09 - 2023.06',
    role: 'Java 开发工程师 · 高级程序员职称',
    company: '周生生（中国）商业有限公司　珠宝品牌自营数字化',
    summary: '',
    spacing: sp(8, 0),
  },
];

function project(name, stack, desc, results) {
  return {
    name,
    stack,
    desc,
    descQuote: true,
    descColor: '#888888',
    pageBreak: false,
    spacing: sp(10, 0),
    nameSpacing: sp(0, 0),
    stackSpacing: sp(0, 0),
    descSpacing: sp(2, 0),
    results: results.map((t, i) => ({ text: t, spacing: sp(i === results.length - 1 ? 0 : 3, 0) })),
  };
}

const PROJECTS = [
  project(
    'comein.cn（进门财经）AI 金融投研工作台 · Agent 基座 / 云沙箱 / 计费 · AI Infra 后台开发',
    '2026.01 — 2026.07 · Python / AgentScope / Flink / 多租户云沙箱',
    '主导 AI 金融投研工作台（AI 进宝）核心基建研发：Agent 基座与多租户云沙箱、MCP / Skill 扩展、AI 资源计费、五端 IM 网关，支撑 Agent 从接入到计费全链路落地。',
    [
      'Agent 基座：基于 QwenPaw / OpenCode 二次开发构建通用 Agent 基座，实现多租户云沙箱隔离执行与 Agent / Skill 全生命周期管控（创建 → 发布 → 下线）。',
      '能力扩展体系：设计 MCP / Skill 统一扩展规范，标准化注册、发现、调用、权限与版本管理，同时兼容 MCP 协议与外部 API，让新工具以配置化方式接入而非逐个硬编码。',
      '成本与可观测：基于 Flink 实时消费腾讯云 AI 网关日志，设计多租户 AI 资源精细化计费链路（实时预扣 / 离线扣费 / 账单校准），日志落库即计量，做到成本实时计量与全链路追溯，支撑资源计费可信可审计。',
      '消息基建：自研分布式 IM 网关，统一承接飞书 / 企微 / 钉钉 / 微信 / QQ 五端消息，支持多副本扩缩容与滚动发布不丢消息。',
    ]
  ),
  project(
    'lessie.cn（指数引力）AI 人脉搜索引擎 · Multi-Agent / Agentic RAG · Agent 工程化',
    '2024.03 — 2025.11 · Python / LangGraph / LlamaIndex / Milvus',
    '主导 AI 人脉搜索引擎：Supervisor / Search / Review 多层级 ReAct Multi-Agent 架构，搜索精准度提升 30%、找人成本降低 80%、定位耗时缩短 60%。',
    [
      '多智能体架构：设计 Supervisor / Search / Review 多层级 ReAct Multi-Agent，用状态机 + 共享上下文消除任务冲突；Context Engineering（压缩 / 分层缓存 / 增量更新）平衡信息完整性与响应稳定性，显著提升搜索精准度、降低找人成本与目标定位耗时。',
      '检索与数据融合：Search Agent 封装 Apollo / LinkedIn / Upfluence / Modash 等 10+ 数据源，Standardizer 统一人物 Schema 支撑多源融合排序；Review Agent 做相关性 / 指标匹配 / 事实校验多维质量评审，以策略模式支撑 B2B 与 KOL 双垂类。',
      '自学习 RAG：RAG Few-Shot 策略（LangSmith 回流 + LlamaIndex + Milvus）动态注入，让检索策略随评测样本持续迭代。',
      '评测与会话：LLM / 工具 / 业务三级埋点经 Kafka 落数仓支撑模型选型；SSE 逐字输出配合 interrupt / resume 实现长任务中断恢复。',
    ]
  ),
  project(
    'hicreator.ai（指数引力）海外红人营销一体化 SaaS 平台 · 业务 FDE 式落地',
    '2024.03 — 2025.11 · Grok LLM / Agent 工作流 / dataworks / Stripe / PostHog',
    '主导红人营销 SaaS 研发：FDE 式定制业务流程，Grok LLM + Agent 工作流串联「客户 → 合同 → 付款 → 结算」，实现客户到结算的全流程自动化闭环。',
    [
      '业务流程 Agent 化：以 FDE 方式与业务各角色对齐诉求、定制标准作业流程，用 Grok LLM + Agent 工作流串联「客户 → 项目 → 合同 → 审批 → 付款 → 结算」自动化闭环，替代线下人工流转。',
      '触达体系：搭建 IM 通信平台打通 TikTok（WebDriver RPA）/ WhatsApp / 邮件渠道与风险检测评估；0 → 1 自建海外邮件群发系统（Resend / AWS SES / SendGrid 统一驱动 + 队列分片限流，LLM 生成营销内容自动调优策略），支撑月均 50 万 + 有效触达；研发群控 RPA 机器人实现自动注册 / 养号、风险检测与私信群发自动化。',
      '数据与知识库：设计 dataworks 数仓同步链路实现 300+ 万网红画像与视频数据日更；自建 KOL 达人数据库与 SEO 引流 Toolkit（达人画像、商品类目、市场规则、合规话术垂直知识库），浏览器插件在 YouTube / IG / TikTok / X / FB 达人主页浮窗展示入库 / 拉黑 / 粉丝与项目信息。',
      '商业化闭环：自建支付中台集成 Stripe，覆盖会员订阅、优惠券、退款对账与风控；用户增长裂变与奖励任务 T+1 结算，PostHog 全链路追踪回溯。',
    ]
  ),
  project(
    '小鹿选房 · 看房日记 · 经纪人 ERP 中台（房极客）',
    '2023.08 — 2024.01',
    '参与小鹿选房 C 端、看房日记 B 端、经纪人 ERP 中台研发，打通新房业务线上流转。',
    [
      '负责新房报备 / 上下架 / 房源跟进 / 权限控制 / 余额划转等模块，打通新房业务线上流转。',
    ]
  ),
  project('电商 ERP 与订单履约（丰速科技）', '2023.07', '短期参与电商 ERP 与订单履约的需求梳理和研发交接。', [
    '对接企得宝 ERP、易打单、速打等覆盖电商全链路的核心产品。',
  ]),
  project(
    '周生生数字化：多渠道潜客 CRM / 门店预约 / 财务审批 / 供应商网关 / 香港帝舵官网',
    '2021.09 — 2023.06 · Java / Spring 全家桶 / JBPM / Redash',
    '负责多渠道潜客 CRM 平台研发，整合大陆、港澳台线上线下销售线索，日活 10W+、销售转化率提升 70%。',
    [
      '搭建门店预约体验流程与预约限额体系，设计分地区业务分层与跨境敏感数据过滤 / 定期清除机制，预约到店率提升 40%。',
      '基于 JBPM 编排财务差异审批流程，任务自动分配并处理超时 / 驳回异常，保障财务审批全流程闭环、替代人工流转。',
      '搭建供应商 API 网关（鉴权 / 额度 / 监控）与 Redash BI 多维看板，支撑供应商管理与经营可视化。',
      '参与香港帝舵官网研发，负责会员体系、订单支付与对账、库存同步模块，打通品牌官网会员、交易、库存一体的线上销售链路。',
    ]
  ),
];

const SKILL_GROUPS = [
  {
    name: 'Agent / Harness',
    keywords:
      '**Multi-Agent 协作编排**（Supervisor / ReAct / 状态机）· **Agentic RAG**（Few-Shot 自学习检索）· Tool Calling · MCP / A2A 协议 · LLM 评测体系 · Context Engineering · 通用 Agent 基座二开（QwenPaw / OpenCode）· 多租户云沙箱隔离执行 · Tool / MCP / Skill 统一扩展体系 · Agent / Skill 全生命周期管控',
    detail:
      'LangChain / LangGraph / LlamaIndex / Langsmith / Langfuse · 多轮对话任务拆解与角色分配 · SSE 流式会话与 interrupt / resume 长任务恢复 · 发布依赖管理与日志上报 · AI 资源精细化计费与链路追溯 · 多租户权限与资源隔离',
    items: [],
  },
  {
    name: 'AI 驱动编程',
    keywords: 'Claude Code / Codex / Cursor（深度使用）· Vibe Coding 高效开发模式',
    detail: '熟悉主流 Coding Agent 底层架构 · 从开发到部署全流程工程化落地',
    items: [],
  },
  {
    name: '数据与中间件',
    keywords: 'Milvus（向量检索）· Kafka · Flink · Redis · ElasticSearch · MySQL / PostgreSQL',
    detail: 'RAG 检索链路与实时数据管道建设 · 缓存 / 消息队列场景化集成 · 实时采集与离线分析',
    items: [],
  },
  {
    name: '后端',
    keywords: 'Python（Agent 主力）· TypeScript / Node · Java（主干 5 年）· Golang',
    detail:
      'Java 生态 5 年主干：Spring Boot / Cloud / MyBatis 全家桶企业级实战，支撑 CRM / ERP / 电商 SaaS 系统落地；按场景选型：后端 Java、AI 层 Python、高并发微服务工程基本功',
    items: [],
  },
  {
    name: '前端',
    keywords:
      'Vue / Vuetify（企业级 Web 管理系统）· UniApp（App 安卓 / iOS 与小程序）· Electron（桌面端应用）',
    detail: 'Vue2 / Vue3 · Web / 移动端 / 小程序 / 桌面端多端开发经验',
    items: [],
  },
  {
    name: 'DevOps',
    keywords:
      'Docker · Kubernetes（kubectl 命令与部署脚本）· Jenkins（独立搭建 CI / CD）· Nexus（独立建设私服）· Git',
    detail: '持续集成流水线与制品库 0 → 1 自建 · 容器化构建交付 · K8s 集群命令行运维实操',
    items: [],
  },
].map((g) => ({
  ...g,
  keywordsSpacing: sp(0, 0),
  nameSpacing: sp(0, 0),
  detailSpacing: sp(0, 0),
  spacing: sp(8, 0),
}));

const EDUCATION_HTML =
  '**中山大学新华学院**　全日制统招本科 · 软件工程 · 国家励志奖学金 · 校级奖学金　2017.09 — 2021.06\n' +
  '学历在线验证码（学信网）：**AH96NG89HCCUWMEA**　查验 www.chsi.com.cn/xlcx/bgcx.jsp · 或学信网 App 扫码 · 有效期至 2027-04-29\n' +
  '主修：线性代数 · 数据结构与算法 · 数据库原理 · 计算机网络 · 计算机组成原理 · 软件工程导论\n' +
  '大四实习前端，毕业后从 Java 后端起步，近两年跨栈至 Python / TypeScript 与 AI 全栈工程';

/* 用户确认「这些岗位都是投这份简历」的 6 个岗位 */
const LINK_JOBS = [
  { company: '唯品会（中国）有限公司', position: '高级全栈开发工程师（工程效能）' },
  { company: 'xTool', position: 'AI 工程师（评测与治理方向）' },
  { company: 'xTool', position: '平台架构师' },
  { company: '拼多多（上海寻梦信息技术有限公司）', position: 'AI平台' },
  { company: '拼多多（上海寻梦信息技术有限公司）', position: '智能体平台工程师（Agentic AI Infrastructure）' },
  { company: 'SHEIN', position: 'AI Infra后台开发' },
];

async function main() {
  const login = await fetch(BASE + '/api/auth/dev-login', { method: 'POST' });
  const raw = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = raw.map((c) => String(c).split(';')[0]).join('; ');

  // 复用主简历的版式参数（fonts / spacing / theme），避免新简历错版
  const resumes = await http('GET', '/api/resumes');
  const master = resumes.find((r) => r.isMaster) || resumes[0];
  const base = master?.payload || {};

  const now = Date.now();
  const payload = {
    v: base.v || 8,
    fonts: base.fonts || undefined,
    spacing: base.spacing || undefined,
    savedAt: now,
    data: {
      meta: 'AI Agent 工程师 / AI 全栈工程师 / 后端开发工程师 / Java 开发工程师',
      name: '陈培胜',
      metaBold: false,
      theme: { id: 'classic', overrides: {} },
      contact: [
        { text: '经验 5 年 · 坐标 广东深圳 · 到岗 随时 · 已离职', spacing: sp(0, 0) },
        { text: '电话 / 微信 +86 180 2283 4605 · 邮箱 shenge.work@gmail.com', spacing: sp(0, 0) },
        { text: '作品集 shenge-work.github.io · GitHub github.com/shenge-work', spacing: sp(0, 0) },
      ],
      sections: [
        {
          id: 's_summary',
          type: 'highlights',
          title: '个人简介',
          pageBreak: false,
          spacing: sp(0, 0),
          cards: SUMMARY,
        },
        {
          id: 's_career',
          type: 'career',
          title: '工作经历',
          pageBreak: false,
          spacing: sp(0, 0),
          items: CAREER.map((c) => ({
            company: c.company,
            role: c.role,
            date: c.date,
            summary: c.summary,
            projects: [],
            spacing: c.spacing,
            companySpacing: sp(0, 0),
            roleSpacing: sp(0, 0),
            dateSpacing: sp(0, 0),
            summarySpacing: sp(0, 0),
          })),
        },
        {
          id: 's_projects',
          type: 'projects',
          title: '项目经历',
          pageBreak: false,
          spacing: sp(0, 0),
          items: PROJECTS,
        },
        {
          id: 's_skills',
          type: 'skills',
          title: '专业技能',
          pageBreak: false,
          spacing: sp(0, 0),
          groups: SKILL_GROUPS,
        },
        {
          id: 's_edu',
          type: 'custom',
          title: '教育经历',
          headingVisible: true,
          pageBreak: false,
          spacing: sp(0, 0),
          html: EDUCATION_HTML,
        },
      ],
    },
    source: {
      kind: 'pdf',
      node: SOURCE_NODE,
      fileName: PDF_NAME,
      importedAt: new Date().toISOString(),
    },
  };

  const title = '陈培胜 · 5年 · 红杉系初创+金融头部AI工程主力';
  const exists = resumes.find((r) => r.title === title);
  let resume;
  if (exists) {
    resume = await http('PUT', `/api/resumes/${exists.id}`, { payload });
    console.log(`✓ 复用已有简历: ${title} (${exists.id})`);
  } else {
    resume = await http('POST', '/api/resumes', {
      title,
      kind: 'master',
      isMaster: false,
      payload,
      tags: ['投递主用', 'AI Agent', '全栈'],
    });
    console.log(`✓ 新建简历: ${title} (${resume.id})`);
  }

  // 原件作为附件挂到简历上，随时可取回核版式
  if (fs.existsSync(PDF_PATH)) {
    const buf = fs.readFileSync(PDF_PATH);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/pdf' }), PDF_NAME);
    try {
      const att = await http(
        'POST',
        `/api/attachments?ownerType=resume&ownerId=${encodeURIComponent(resume.id)}`,
        form,
        true
      );
      console.log(`✓ 附件已挂载: ${att.originalName} (${att.id})`);
    } catch (e) {
      console.log(`! 附件挂载失败（不影响主流程）: ${e.message}`);
    }
  }

  // 关联 6 个岗位
  const apps = await http('GET', '/api/applications');
  const companies = await http('GET', '/api/companies');
  const byName = new Map(companies.map((c) => [String(c.name || '').trim().toLowerCase(), c]));
  let linked = 0;
  for (const job of LINK_JOBS) {
    const co = byName.get(job.company.toLowerCase());
    if (!co) {
      console.log(`✗ 未找到公司: ${job.company}`);
      continue;
    }
    const app = apps.find(
      (a) => a.companyId === co.id && String(a.position || '').trim() === job.position
    );
    if (!app) {
      console.log(`✗ 未找到投递记录: ${job.company} · ${job.position}`);
      continue;
    }
    await http('PUT', `/api/applications/${app.id}`, { resumeId: resume.id });
    console.log(`✓ 关联投递: ${job.company} · ${job.position}`);
    linked++;
  }
  console.log(`\n=== 完成：简历 ${resume.id}，关联 ${linked} 个岗位 ===`);
}

main().catch((e) => {
  console.error('录入失败:', e.message || e);
  process.exit(1);
});
