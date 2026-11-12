/**
 * 录入「快手 · 可灵AI专项」与「Anker 安克创新」的 JD / 投递记录 / 公司档案。
 *
 * 数据源：
 *  - 快手招聘（已登录）投递记录：全栈开发工程师（数据平台方向）-【可灵AI专项】，深圳，内推，初筛，2026.11.09
 *  - Anker 飞书内推应聘记录：4 个岗位，均为「内推投递 / 2026-11-09」，JD 正文逐条从详情页抄录
 *
 * 走本地正式 HTTP API（触发器 / application_events / change_log 正常落库），不直连 PGlite。
 * 幂等：公司按 id 复用并合并 payload；JD 按 (companyId, title)；投递按 (companyId, position)。
 *
 * 用法：node scripts/import-anker-kuaishou.js
 */

const BASE = process.env.CA_BASE || 'http://127.0.0.1:3000';
const RESUME_ID = 'res_6b447b75cb0b2e173a'; // 陈培胜 · 5年 · 红杉系初创+金融头部AI工程主力

let cookie = '';

async function http(method, path, body) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/* ============================================================ 公司档案 */

const COMPANIES = [
  {
    key: 'kuaishou',
    id: 'co_5220c5020b4dd0dccb', // 已有空壳（脉脉内推采集），复用并补全
    name: '快手',
    payload: {
      legalName: '北京快手科技有限公司',
      industry: '互联网 / 短视频 / 内容社区',
      industryCategory: '互联网',
      size: '10000人以上',
      funding: '已上市（港交所 01024.HK）',
      location: '北京·海淀区（总部） / 深圳·南山区',
      city: '北京',
      website: 'https://www.kuaishou.com',
      careersUrl: 'https://zhaopin.kuaishou.cn',
      tags: ['脉脉内推', '待调研', '飞书/官网内推', '可灵AI', '已上市'],
      summary:
        '快手是领先的内容社区与社交平台，短视频行业开创者之一，业务覆盖短视频、直播、电商、本地生活、广告与海外。可灵 AI（Kling）为其自研视频生成大模型，本岗位隶属可灵 AI 专项，负责可灵数据平台的前后端建设。',
      research: [
        {
          id: 'ks-intro-20261109',
          dim: '公司简介',
          url: 'https://zhaopin.kuaishou.cn',
          date: '2026-11-09',
          content:
            '北京快手科技有限公司，港股上市（01024.HK），员工规模 10000 人以上，总部北京海淀，深圳设研发中心（南山区百度国际大厦等）。可灵 AI 为公司自研视频生成大模型业务线，2026 年持续扩招工程与产品岗位。',
          platform: '快手招聘官网',
        },
        {
          id: 'ks-channel-20261109',
          dim: '投递渠道',
          url: 'https://zhaopin.kuaishou.cn/recruit/e/#/official/social/',
          date: '2026-11-09',
          content:
            '社招官网投递记录显示：渠道「内推」，当前环节「初筛」，投递时间 2026.11.09，意向地点深圳。',
          platform: '快手招聘官网',
        },
      ],
    },
  },
  {
    key: 'anker',
    id: 'boss_anker', // 已有档案最全且已挂 1 个岗位，作为主条目
    name: 'Anker（安克创新）',
    rename: true,
    payload: {
      legalName: '安克创新科技股份有限公司',
      industry: '智能硬件 / 消费电子',
      industryCategory: '消费电子',
      size: '1000-9999人',
      funding: '已上市（深交所 300866.SZ）',
      location: '深圳·南山区',
      city: '深圳',
      website: 'https://www.anker.com',
      careersUrl: 'https://anker-in.jobs.feishu.cn',
      tags: ['BOSS直聘', '飞书内推', '智能硬件', '跨境电商', '已上市'],
      summary:
        '安克创新（Anker Innovations，300866.SZ）成立于 2011 年，全球化消费电子品牌企业，旗下有 Anker（充电）、eufy（智能家居/安防）、Soundcore（音频）、Nebula（激光投影）、AnkerWork（智能办公）、AnkerMake（3D 打印）等品牌，95% 以上营收来自海外，覆盖 140+ 国家。2025 年起在深圳组建 AI 工程团队，推进 Agent 在研发、制造、体验测评等场景落地。',
      research: [
        {
          id: 'anker-intro-20261109',
          dim: '公司简介',
          url: 'https://anker-in.jobs.feishu.cn',
          date: '2026-11-09',
          content:
            '安克创新科技股份有限公司（300866.SZ）2011 年成立，全球化消费电子品牌，接近 2000 名智能硬件研发工程师，布局高效能电源、AIoT、算法与云计算、智能声学、智能安防；95% 以上营收来自海外，覆盖 140 多个国家与地区、超 1 亿用户。',
          platform: '公司官网 / 招聘官网',
        },
        {
          id: 'anker-channel-20261109',
          dim: '投递渠道',
          url: 'https://anker-in.jobs.feishu.cn',
          date: '2026-11-09',
          content:
            '飞书内推站「应聘记录」显示 4 个岗位均为「内推投递」，投递简历时间 2026-11-09；另有 2026-11-08 通过 BOSS 直聘投递「全栈开发工程师（AI 工程方向）」，以及 2026-11-03 交换简历的「AI全栈工程师（30-50K·14薪）」。',
          platform: '飞书内推站 / BOSS直聘',
        },
      ],
    },
  },
];

/* ============================================================ JD 正文 */

const KS_JD = `职位描述
岗位职责
1、负责可灵数据平台前后端架构设计与功能研发，探索并落地通用业务场景的技术解决方案；
2、主导管理后台前后端开发，建设数据资产管理、权限控制、系统配置等核心功能模块；
3、参与平台工程技术体系建设，负责性能优化、代码重构、稳定性保障及数据可视化等基建工具开发，极致提升系统加载速度与运行效率；
4、推动前端交互与用户体验升级，通过组件化、流程化、配置化方案及低代码/页面搭建等技术能力，赋能产品与运营，大幅提升产研团队的交付效率。

任职要求
1、计算机或相关专业本科及以上学历，具有 3 年及以上全栈开发经验；
2、熟练掌握 HTML/CSS/JavaScript，深入理解 TypeScript，精通 React / Vue 等至少一种主流前端框架及其生态；
3、具备良好的服务端开发经验，熟悉 Java/Python 语言，能够独立承担管理后台的 API 设计与前后端闭环开发；
4、有性能调优和复杂中后台系统架构设计的实战经验；
5、具备优秀的业务抽象与逻辑分析能力，沟通驱动力强，对技术有热情；
6、有 AI 辅助编程实践经验优先。`;

const ANKER_AGENT_JD = `职位描述
岗位职责
1、Agent 全生命周期管理：作为 Agent 的产品经理与主要开发者，负责从概念、计划、开发、验证到发布的完整流程，确保 Agent 解决实际业务痛点并实现规模化复用。
2、Agent 工具深度应用与开发：熟练使用 MOPA/APPS 平台进行智能体开发，利用 AI 辅助需求拆解、自动化测试、代码审查与文档生成，同时具备审查 AI 输出、识别潜在风险的批判思维。
3、架构能力沉淀与推广：参与架构设计方法论的提炼，推动技术标准、设计规范的制定与落地，将优秀实践转化为可复用的模板与工具。
4、跨团队协作与赋能：与 PMO、数据、工具及 SDT 团队紧密协作，共同解决专业卡点，推动能力资产在业务中的广泛应用。
5、数据驱动的持续优化：掌握数据管理基础能力，通过分析 Agent 使用数据、研发质量数据，持续迭代优化解决方案，量化提效成果。

任职要求
1. 知识与技术栈
软件架构设计：深刻理解软件架构设计原则，熟悉高内聚、低耦合的模块化设计思想。
系统工程方法论：熟悉系统工程，能将用户场景问题转化为系统需求，并为各组件分配功能与性能指标。
主流技术栈：精通至少一门开发语言（如 Java/Go/Python），熟悉分布式系统、微服务架构、数据库设计与性能优化。
AI 工具应用：有实际使用 AI 工具（如 Copilot、Claude、Prompt 工程）构建工具或提升开发效率的经验。
2. 经验背景
工作经验：5 年以上软件开发经验，有完整的消费电子产品系统开发经历（从立项到量产）。
架构设计：具备架构设计经验，有跨代产品平台架构设计或主导架构重构的经历。
跨团队协作：具备与硬件、软件、算法等多团队协同的经历，能推动技术方案落地。
3. 核心能力
问题定义与拆解：面对模糊需求，能快速厘清问题本质与边界，抓住关键，提供长期可落地的全局最优解。
方案设计与权衡：在成本、性能、可靠性等多重约束下，具备出色的方案设计与多方案权衡能力。
批判思维：对仿真结论、AI 推荐方案、供应商意见保持审辨，不轻易接受未经验证的结论。
AI 协作能力：能战略性安排人-AI 分工，在关键节点注入专业判断，让最终产出超越纯 AI 或纯人工。
4. 软性素质
自驱力与责任心：拥有强烈的 Ownership 精神，积极推动目标落地。
学习与创新能力：主动关注行业新技术，乐于在工作中进行创新性尝试。
沟通与表达：能够清晰扼要地描述复杂问题，有效进行跨部门沟通。`;

const ANKER_FULLSTACK_JD = `职位描述
核心职责
全栈系统开发
后端：设计和开发数据服务 API（Python / Java / Node.js 等），对接数据平台和数据仓库
前端：构建数据洞察看板和分析平台（React / Vue），实现数据可视化与交互分析
设计系统架构，确保可扩展性和可维护性
编写自动化测试，保障代码质量

AI 应用层开发
基于 LLM 构建智能分析能力：情感分析、问题归因、趋势洞察、自动报告生成
设计和开发 AI Agent 工作流，实现数据查询 → 分析 → 可视化的自动化链路
构建 RAG / 知识库系统，支撑业务人员自然语言查询数据
Prompt Engineering 优化，确保 AI 输出质量和稳定性

数据工程协作
与数据工程师协作，理解数据模型和分层架构
参与数据质量规则设计和监控
优化数据查询性能，支撑实时/准实时分析场景

任职要求
必须（Must Have）
前端开发：3 年以上前端开发经验，精通 React 或 Vue 生态，有数据可视化项目经验
后端开发：3 年以上后端开发经验，精通 Python Java 或 Node.js，熟悉 RESTful API 设计和数据库操作
AI/LLM 应用：有 LLM 应用开发实战经验，熟悉大模型 API，掌握 Prompt Engineering、RAG、Function Calling 等核心技术
工程能力：扎实的计算机基础，熟悉 Git 工作流、CI/CD、容器化部署，有良好的代码规范和文档习惯
学历：本科及以上，计算机、软件工程、数据科学等相关专业

加分（Nice to Have）
AI Agent 开发：有 AI Agent / 多智能体系统开发经验，熟悉 LangChain、AutoGen、CrewAI 等框架
数据工程：了解数据仓库分层架构，有 Spark / Databricks / Delta Lake 使用经验
NLP：有文本分类、情感分析、关键词提取等 NLP 任务经验
云平台：有阿里云、AWS、Azure 等云平台使用经验
全栈项目：有从 0 到 1 搭建数据产品 / AI 产品的完整经验`;

const ANKER_FDE_JD = `职位描述
岗位职责
发现机会：深入业务线，理解流程、痛点、数据流。不只「听需求」——你要比业务方更清楚 AI 能在哪里产生最大杠杆，然后说服他们为什么做这个、不做那个。
交付方案：判断场景适合什么形态。能自己做的直接用 AI 工具做出来。需要专有能力的（工具开发、数据工程），写出足够清晰的规格，协调 IT 或数据团队接棒，把关交付质量。
追踪效果：上线不是结束。追踪业务指标的变化，持续迭代直到效果达标。你对「这个 Agent 有没有真的在工作」的判断，不是看它有没有报错，是看业务数字动了没有。
反哺方法论：从自己的交付中提炼规律——什么场景适合什么方案、什么判断标准有效、什么坑别人也会踩——反哺给团队，让下一个 FDE 站得更高。

任职要求
必备
快速穿透陌生业务域。不需要多年行业经验，但你需要能两周内从「外行」到「能跟业务 Leader 做有效对话」——听懂行话、看清流程、找准痛点。
AI 是你日常工作的主要生产力工具。面试时我们希望看到：给你一个场景，你如何跟 AI 协作把它做出来。不是「我会用 ChatGPT」，是「AI 已经融入我日常做东西的方式」。
端到端交付过实际项目，且你是主要动手的人。能讲清楚全链路：进入了什么业务场景 → 你发现了什么机会（不是被分配的）→ 流程怎么改的 → 你具体做了什么 → 业务效果是什么。不是你协调的、不是你参与了一部分的。
你亲手发现过机会，不是被分配任务。你能讲清楚：进入一个陌生业务场景后，你怎么判断哪里值得做、哪里不值得。你梳理过业务流程，识别了 AI 化的关键节点——而不是拿着一个现成的「帮我做一个 XX」开始写代码。
能判断什么值得做、什么不值得做。面对新场景，能快速识别关键假设、定义 MVP 范围、说清楚「我们先花最小成本验证什么」。

技术方向
不要求全部命中，通过实操考核验证。
AI-native 工作方式。日常面对的不是一个编辑器，而是多个 Agent 并行执行的工作流。迭代速度由「你和 Agent 之间的反馈闭环」决定，不是由手写代码的速度决定。
提示工程 & 上下文工程。不只是写单条 prompt——能设计 prompt 系统、管理上下文窗口（什么进、什么压缩、什么淘汰），能搭建评测体系，用数据迭代而非凭感觉调。
Agent 设计与评估。能设计工具集、编排逻辑、安全护栏——权限控制、注入防御、幻觉检测、人机协同。评估 Agent 不以「像人」为标准，以任务成功率、稳定性和成本效率为标尺。
Python。能写生产级数据管道，集成 LLM API，通过轻量 API 暴露 Agent 能力。不需要训练模型或构建分布式系统。有版本控制和测试的习惯。

加分项
跨团队协调与需求定义
从单点场景到跨流程复杂方案的演进
方法论提炼——从自己的案例中抽象出可复用的规律`;

const ANKER_UX_JD = `职位描述
岗位职责
1、业务洞察与需求转化：深入体验测评业务，识别可工具化、AI 化的提效环节；把业务诉求转化为明确的工具需求，主动提出方案并推动落地；
2、AI 应用与智能体开发：基于大模型 API 开发智能问答、自动化分析等功能，负责 Prompt 设计、工作流编排与效果调优；构建体验分析场景的智能体与自动化流程；
3、体验数据资产建设：参与体验测评数据体系建设，梳理数据来源、定义指标口径、打通数据链路；搭建体验数据看板，支撑业务分析与决策；
4、方法沉淀与团队赋能：将实践经验沉淀为可复用的方法论、模板与技术文档；跟踪 AI 新技术趋势，协助开展工具应用培训与分享。

任职要求
1、学历背景：本科及以上学历，计算机、人工智能、体验设计、心理学等相关专业；
2、能力要求：
1）对 AI 应用与开发工具充满兴趣，敢于尝试并快速上手；
2）善于理解业务需求，用技术思考解决方案；
3）逻辑清晰、学习能力强，具备良好的协作沟通能力；
3、加分项：
1）熟悉编程语言（Python/JavaScript/Java 等），有端到端交付过 AI 应用项目实战经验优先；
2）了解大模型应用开发，有 AI 工具搭建或全栈开发经验优先；
3）具备数据分析能力，熟悉 SQL 或数据查询语言；
4、作为团队的一员，我们希望您：
1）具有结构化思维：善于将复杂问题拆解为可执行的步骤和流程；
2）成就驱动：保持学习心态，有内在动力去探索如何用技术真正提升效率；
3）面对冲突：面对技术方案分歧时，能基于数据和实验结果做出理性判断；
4）用户中心导向：理解技术服务业务，始终以能否真正帮到团队和用户为判断标准。`;

/* ============================================================ 岗位清单 */

const JOBS = [
  {
    companyKey: 'kuaishou',
    position: '全栈开发工程师（数据平台方向）-【可灵AI专项】',
    jdText: KS_JD,
    meta: {
      title: '全栈开发工程师（数据平台方向）-【可灵AI专项】',
      jobCode: '',
      externalJobId: '',
      recommendCode: '',
      category: '工程类',
      level: '',
      department: '可灵AI专项 · 数据平台',
      education: '本科及以上',
      experience: '3-5年',
      employmentType: '全职',
      city: '深圳',
      location: '北京 / 深圳',
      headcount: '',
      salary: '',
      publishDate: '',
      publishDateNote: '快手招聘列表仅展示「更新时间 2026.10.12」，不展示首次发布时间',
      updatedDate: '2026-10-12',
      isUrgent: false,
      recruiter: '',
      source: '快手招聘官网 · 内推',
      sourcePlatform: '快手招聘（zhaopin.kuaishou.cn）社招',
      channel: '内推',
      stage: '初筛',
      jdUrl: 'https://zhaopin.kuaishou.cn/recruit/e/#/official/social/',
      skills: [
        'React',
        'Vue',
        'TypeScript',
        'JavaScript',
        'Java',
        'Python',
        '数据平台',
        '管理后台',
        '低代码/页面搭建',
        '数据可视化',
        '性能优化',
        'AI 辅助编程',
      ],
    },
    duties: [
      '负责可灵数据平台前后端架构设计与功能研发，探索并落地通用业务场景的技术解决方案',
      '主导管理后台前后端开发，建设数据资产管理、权限控制、系统配置等核心功能模块',
      '参与平台工程技术体系建设，负责性能优化、代码重构、稳定性保障及数据可视化等基建工具开发，极致提升系统加载速度与运行效率',
      '推动前端交互与用户体验升级，通过组件化、流程化、配置化方案及低代码/页面搭建等技术能力，赋能产品与运营，大幅提升产研团队的交付效率',
    ],
    requirements: [
      '计算机或相关专业本科及以上学历，具有 3 年及以上全栈开发经验',
      '熟练掌握 HTML/CSS/JavaScript，深入理解 TypeScript，精通 React / Vue 等至少一种主流前端框架及其生态',
      '具备良好的服务端开发经验，熟悉 Java/Python 语言，能够独立承担管理后台的 API 设计与前后端闭环开发',
      '有性能调优和复杂中后台系统架构设计的实战经验',
      '具备优秀的业务抽象与逻辑分析能力，沟通驱动力强，对技术有热情',
      '有 AI 辅助编程实践经验优先',
    ],
    bonus: [],
  },
  {
    companyKey: 'anker',
    position: 'AI智能体开发工程师（架构设计领域）',
    jdText: ANKER_AGENT_JD,
    meta: {
      title: 'AI智能体开发工程师（架构设计领域）',
      externalJobId: '7663768588339890438',
      category: 'AI / 智能体',
      department: '',
      education: '本科及以上',
      experience: '5 年以上',
      employmentType: '社招-全职',
      city: '深圳',
      location: '深圳',
      industryLabel: '互联网/电子/网游',
      publishDate: '',
      publishDateNote: '飞书内推「应聘记录」不展示岗位发布时间，仅展示投递时间 2026-11-09',
      isUrgent: false,
      source: '安克创新飞书内推',
      sourcePlatform: '飞书招聘内推站（anker-in.jobs.feishu.cn）',
      channel: '内推',
      jdUrl:
        'https://anker-in.jobs.feishu.cn/referral/position/7663768588339890438/detail',
      skills: [
        'AI Agent',
        '智能体开发',
        'MOPA',
        'APPS 平台',
        'Java',
        'Go',
        'Python',
        '分布式系统',
        '微服务架构',
        '软件架构设计',
        '系统工程',
        'Prompt 工程',
        'Copilot',
        'Claude',
        '消费电子',
        '跨团队协作',
        'AI 辅助测试',
      ],
    },
    duties: [
      'Agent 全生命周期管理：作为 Agent 的产品经理与主要开发者，负责从概念、计划、开发、验证到发布的完整流程，确保 Agent 解决实际业务痛点并实现规模化复用',
      'Agent 工具深度应用与开发：熟练使用 MOPA/APPS 平台进行智能体开发，利用 AI 辅助需求拆解、自动化测试、代码审查与文档生成，同时具备审查 AI 输出、识别潜在风险的批判思维',
      '架构能力沉淀与推广：参与架构设计方法论的提炼，推动技术标准、设计规范的制定与落地，将优秀实践转化为可复用的模板与工具',
      '跨团队协作与赋能：与 PMO、数据、工具及 SDT 团队紧密协作，共同解决专业卡点，推动能力资产在业务中的广泛应用',
      '数据驱动的持续优化：掌握数据管理基础能力，通过分析 Agent 使用数据、研发质量数据，持续迭代优化解决方案，量化提效成果',
    ],
    requirements: [
      '[知识与技术栈] 软件架构设计：深刻理解软件架构设计原则，熟悉高内聚、低耦合的模块化设计思想',
      '[知识与技术栈] 系统工程方法论：熟悉系统工程，能将用户场景问题转化为系统需求，并为各组件分配功能与性能指标',
      '[知识与技术栈] 主流技术栈：精通至少一门开发语言（如 Java/Go/Python），熟悉分布式系统、微服务架构、数据库设计与性能优化',
      '[知识与技术栈] AI 工具应用：有实际使用 AI 工具（如 Copilot、Claude、Prompt 工程）构建工具或提升开发效率的经验',
      '[经验背景] 工作经验：5 年以上软件开发经验，有完整的消费电子产品系统开发经历（从立项到量产）',
      '[经验背景] 架构设计：具备架构设计经验，有跨代产品平台架构设计或主导架构重构的经历',
      '[经验背景] 跨团队协作：具备与硬件、软件、算法等多团队协同的经历，能推动技术方案落地',
      '[核心能力] 问题定义与拆解：面对模糊需求，能快速厘清问题本质与边界，抓住关键，提供长期可落地的全局最优解',
      '[核心能力] 方案设计与权衡：在成本、性能、可靠性等多重约束下，具备出色的方案设计与多方案权衡能力',
      '[核心能力] 批判思维：对仿真结论、AI 推荐方案、供应商意见保持审辨，不轻易接受未经验证的结论',
      '[核心能力] AI 协作能力：能战略性安排人-AI 分工，在关键节点注入专业判断，让最终产出超越纯 AI 或纯人工',
      '[软性素质] 自驱力与责任心：拥有强烈的 Ownership 精神，积极推动目标落地',
      '[软性素质] 学习与创新能力：主动关注行业新技术，乐于在工作中进行创新性尝试',
      '[软性素质] 沟通与表达：能够清晰扼要地描述复杂问题，有效进行跨部门沟通',
    ],
    bonus: [],
  },
  {
    companyKey: 'anker',
    position: 'AI全栈工程师',
    jdText: ANKER_FULLSTACK_JD,
    meta: {
      title: 'AI全栈工程师',
      externalJobId: '',
      category: 'AI / 全栈',
      department: '',
      education: '本科及以上',
      experience: '3 年以上',
      employmentType: '社招-全职',
      city: '深圳',
      location: '长沙 / 深圳（意向城市：深圳）',
      industryLabel: '互联网/电子/网游',
      publishDate: '',
      publishDateNote: '飞书内推「应聘记录」不展示岗位发布时间，仅展示投递时间 2026-11-09',
      isUrgent: false,
      source: '安克创新飞书内推',
      sourcePlatform: '飞书招聘内推站（anker-in.jobs.feishu.cn）',
      channel: '内推',
      jdUrl: 'https://anker-in.jobs.feishu.cn',
      skills: [
        'React',
        'Vue',
        '数据可视化',
        'Python',
        'Java',
        'Node.js',
        'RESTful API',
        'LLM',
        'RAG',
        'Prompt Engineering',
        'Function Calling',
        'AI Agent',
        'LangChain',
        'AutoGen',
        'CrewAI',
        'Spark',
        'Databricks',
        'Delta Lake',
        'NLP',
        'CI/CD',
        '容器化部署',
      ],
    },
    duties: [
      '[全栈系统开发] 后端：设计和开发数据服务 API（Python / Java / Node.js 等），对接数据平台和数据仓库',
      '[全栈系统开发] 前端：构建数据洞察看板和分析平台（React / Vue），实现数据可视化与交互分析',
      '[全栈系统开发] 设计系统架构，确保可扩展性和可维护性',
      '[全栈系统开发] 编写自动化测试，保障代码质量',
      '[AI 应用层开发] 基于 LLM 构建智能分析能力：情感分析、问题归因、趋势洞察、自动报告生成',
      '[AI 应用层开发] 设计和开发 AI Agent 工作流，实现数据查询 → 分析 → 可视化的自动化链路',
      '[AI 应用层开发] 构建 RAG / 知识库系统，支撑业务人员自然语言查询数据',
      '[AI 应用层开发] Prompt Engineering 优化，确保 AI 输出质量和稳定性',
      '[数据工程协作] 与数据工程师协作，理解数据模型和分层架构',
      '[数据工程协作] 参与数据质量规则设计和监控',
      '[数据工程协作] 优化数据查询性能，支撑实时/准实时分析场景',
    ],
    requirements: [
      '[Must Have] 前端开发：3 年以上前端开发经验，精通 React 或 Vue 生态，有数据可视化项目经验',
      '[Must Have] 后端开发：3 年以上后端开发经验，精通 Python / Java / Node.js，熟悉 RESTful API 设计和数据库操作',
      '[Must Have] AI/LLM 应用：有 LLM 应用开发实战经验，熟悉大模型 API，掌握 Prompt Engineering、RAG、Function Calling 等核心技术',
      '[Must Have] 工程能力：扎实的计算机基础，熟悉 Git 工作流、CI/CD、容器化部署，有良好的代码规范和文档习惯',
      '[Must Have] 学历：本科及以上，计算机、软件工程、数据科学等相关专业',
    ],
    bonus: [
      'AI Agent 开发：有 AI Agent / 多智能体系统开发经验，熟悉 LangChain、AutoGen、CrewAI 等框架',
      '数据工程：了解数据仓库分层架构，有 Spark / Databricks / Delta Lake 使用经验',
      'NLP：有文本分类、情感分析、关键词提取等 NLP 任务经验',
      '云平台：有阿里云、AWS、Azure 等云平台使用经验',
      '全栈项目：有从 0 到 1 搭建数据产品 / AI 产品的完整经验',
    ],
  },
  {
    companyKey: 'anker',
    position: 'AI业务工程师 — Agent 交付方向 AI Business Engineer (Forward Deployed)',
    jdText: ANKER_FDE_JD,
    meta: {
      title: 'AI业务工程师 — Agent 交付方向 AI Business Engineer (Forward Deployed)',
      externalJobId: '',
      category: 'AI / FDE（交付）',
      department: '',
      education: '本科及以上',
      experience: '不限（更看重端到端交付实绩）',
      employmentType: '社招-全职',
      city: '深圳',
      location: '深圳',
      industryLabel: '互联网/电子/网游',
      publishDate: '',
      publishDateNote: '飞书内推「应聘记录」不展示岗位发布时间，仅展示投递时间 2026-11-09',
      isUrgent: false,
      source: '安克创新飞书内推',
      sourcePlatform: '飞书招聘内推站（anker-in.jobs.feishu.cn）',
      channel: '内推',
      jdUrl: 'https://anker-in.jobs.feishu.cn',
      skills: [
        'AI Agent',
        'Forward Deployed',
        'Prompt 工程',
        '上下文工程',
        'Agent 评测',
        '工具集设计',
        '安全护栏',
        'Python',
        'LLM API',
        '业务洞察',
        'MVP 定义',
        '方法论沉淀',
      ],
    },
    duties: [
      '发现机会：深入业务线，理解流程、痛点、数据流。不只「听需求」——你要比业务方更清楚 AI 能在哪里产生最大杠杆，然后说服他们为什么做这个、不做那个',
      '交付方案：判断场景适合什么形态。能自己做的直接用 AI 工具做出来。需要专有能力的（工具开发、数据工程），写出足够清晰的规格，协调 IT 或数据团队接棒，把关交付质量',
      '追踪效果：上线不是结束。追踪业务指标的变化，持续迭代直到效果达标。你对「这个 Agent 有没有真的在工作」的判断，不是看它有没有报错，是看业务数字动了没有',
      '反哺方法论：从自己的交付中提炼规律——什么场景适合什么方案、什么判断标准有效、什么坑别人也会踩——反哺给团队，让下一个 FDE 站得更高',
    ],
    requirements: [
      '[必备] 快速穿透陌生业务域：不需要多年行业经验，但需要能两周内从「外行」到「能跟业务 Leader 做有效对话」——听懂行话、看清流程、找准痛点',
      '[必备] AI 是日常工作的主要生产力工具：面试时会给一个场景，考察你如何跟 AI 协作把它做出来，而不是「我会用 ChatGPT」',
      '[必备] 端到端交付过实际项目，且是主要动手的人：能讲清全链路（业务场景 → 发现机会 → 流程改造 → 自己做了什么 → 业务效果）',
      '[必备] 亲手发现过机会，不是被分配任务：进入陌生业务场景后能判断哪里值得做，梳理业务流程并识别 AI 化关键节点',
      '[必备] 能判断什么值得做、什么不值得做：面对新场景快速识别关键假设、定义 MVP 范围、说清最小成本验证路径',
      '[技术方向] AI-native 工作方式：日常面对多个 Agent 并行执行的工作流，迭代速度由「人与 Agent 的反馈闭环」决定',
      '[技术方向] 提示工程 & 上下文工程：能设计 prompt 系统、管理上下文窗口（什么进、什么压缩、什么淘汰），搭建评测体系，用数据迭代',
      '[技术方向] Agent 设计与评估：能设计工具集、编排逻辑、安全护栏（权限控制、注入防御、幻觉检测、人机协同），以任务成功率、稳定性、成本效率为标尺',
      '[技术方向] Python：能写生产级数据管道，集成 LLM API，通过轻量 API 暴露 Agent 能力；有版本控制和测试习惯',
    ],
    bonus: [
      '跨团队协调与需求定义',
      '从单点场景到跨流程复杂方案的演进',
      '方法论提炼——从自己的案例中抽象出可复用的规律',
    ],
  },
  {
    companyKey: 'anker',
    position: 'AI应用工程师（用户体验方向）',
    jdText: ANKER_UX_JD,
    meta: {
      title: 'AI应用工程师（用户体验方向）',
      externalJobId: '7704877248335579402',
      category: 'AI / 体验测评',
      department: '体验测评',
      education: '本科及以上',
      experience: '不限（3 年以上为佳）',
      employmentType: '社招-全职',
      city: '深圳',
      location: '深圳',
      industryLabel: '智能制造/工业互联网/工业自动化',
      publishDate: '',
      publishDateNote: '飞书内推「应聘记录」不展示岗位发布时间，仅展示投递时间 2026-11-09',
      isUrgent: false,
      source: '安克创新飞书内推',
      sourcePlatform: '飞书招聘内推站（anker-in.jobs.feishu.cn）',
      channel: '内推',
      jdUrl:
        'https://anker-in.jobs.feishu.cn/referral/position/7704877248335579402/detail',
      skills: [
        '大模型 API',
        'Prompt 设计',
        '工作流编排',
        '智能体开发',
        'Python',
        'JavaScript',
        'Java',
        'SQL',
        '数据分析',
        '数据看板',
        '体验测评',
        '自动化流程',
      ],
    },
    duties: [
      '业务洞察与需求转化：深入体验测评业务，识别可工具化、AI 化的提效环节；把业务诉求转化为明确的工具需求，主动提出方案并推动落地',
      'AI 应用与智能体开发：基于大模型 API 开发智能问答、自动化分析等功能，负责 Prompt 设计、工作流编排与效果调优；构建体验分析场景的智能体与自动化流程',
      '体验数据资产建设：参与体验测评数据体系建设，梳理数据来源、定义指标口径、打通数据链路；搭建体验数据看板，支撑业务分析与决策',
      '方法沉淀与团队赋能：将实践经验沉淀为可复用的方法论、模板与技术文档；跟踪 AI 新技术趋势，协助开展工具应用培训与分享',
    ],
    requirements: [
      '[学历背景] 本科及以上学历，计算机、人工智能、体验设计、心理学等相关专业',
      '[能力要求] 对 AI 应用与开发工具充满兴趣，敢于尝试并快速上手',
      '[能力要求] 善于理解业务需求，用技术思考解决方案',
      '[能力要求] 逻辑清晰、学习能力强，具备良好的协作沟通能力',
      '[团队期望] 结构化思维：善于将复杂问题拆解为可执行的步骤和流程',
      '[团队期望] 成就驱动：保持学习心态，有内在动力去探索如何用技术真正提升效率',
      '[团队期望] 面对冲突：面对技术方案分歧时，能基于数据和实验结果做出理性判断',
      '[团队期望] 用户中心导向：理解技术服务业务，始终以能否真正帮到团队和用户为判断标准',
    ],
    bonus: [
      '熟悉编程语言（Python/JavaScript/Java 等），有端到端交付过 AI 应用项目实战经验优先',
      '了解大模型应用开发，有 AI 工具搭建或全栈开发经验优先',
      '具备数据分析能力，熟悉 SQL 或数据查询语言',
    ],
  },
];

/* ============================================================ 主流程 */

async function main() {
  const login = await fetch(BASE + '/api/auth/dev-login', { method: 'POST' });
  if (!login.ok) throw new Error('dev-login 失败: ' + (await login.text()).slice(0, 200));
  const raw = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = raw.map((c) => String(c).split(';')[0]).join('; ');
  const me = await login.json();
  console.log(`✓ 会话建立: ${me.user.email} (${me.user.id})`);

  // 1) 公司：复用历史条目，合并 payload（research/tags 去重，不丢原有内容）
  const companies = await http('GET', '/api/companies');
  const companyIds = {};
  for (const c of COMPANIES) {
    const found = companies.find((x) => x.id === c.id);
    if (!found) throw new Error(`公司不存在: ${c.id} ${c.name}`);
    const old = found.payload || {};
    const merged = { ...old, ...c.payload };
    merged.tags = [...new Set([...(old.tags || []), ...(c.payload.tags || [])])];
    const oldRes = Array.isArray(old.research) ? old.research : [];
    const newRes = Array.isArray(c.payload.research) ? c.payload.research : [];
    const seen = new Set(oldRes.map((r) => r.id));
    merged.research = [...oldRes, ...newRes.filter((r) => !seen.has(r.id))];
    // summary 用更完整的版本
    merged.summary = c.payload.summary || old.summary;
    const body = { payload: merged };
    if (c.rename) body.name = c.name;
    await http('PUT', `/api/companies/${c.id}`, body);
    companyIds[c.key] = c.id;
    console.log(`✓ 补全公司档案: ${c.name} (${c.id}) · research ${merged.research.length} 条`);
  }

  // 2) JD + 投递记录
  for (const job of JOBS) {
    const companyId = companyIds[job.companyKey];
    const company = COMPANIES.find((c) => c.key === job.companyKey);

    const jdPayload = {
      ...job.meta,
      duties: job.duties,
      requirements: job.requirements,
      bonus: job.bonus,
      jdSummary: job.duties[0] || '',
      jdText: job.jdText,
      capturedAt: '2026-11-09',
    };

    const existingJds = await http('GET', `/api/companies/${companyId}/jds`);
    let jdRow = existingJds.find((j) => String(j.payload?.title || '').trim() === job.meta.title);
    if (jdRow) {
      jdRow = await http('PUT', `/api/companies/${companyId}/jds/${jdRow.id}`, { payload: jdPayload });
      console.log(`  ↻ 更新 JD: ${job.meta.title} (${jdRow.id})`);
    } else {
      jdRow = await http('POST', `/api/companies/${companyId}/jds`, { payload: jdPayload });
      console.log(`  ✓ 录入 JD: ${job.meta.title} (${jdRow.id})`);
    }

    const apps = await http('GET', '/api/applications');
    const existing = apps.find(
      (a) => a.companyId === companyId && String(a.position || '').trim() === job.position
    );
    if (existing) {
      console.log(`  已被录入过，跳过投递: ${job.position} [${existing.status}]`);
      continue;
    }

    // 先建「意向」再改「已投递」：createApplication 不写 appliedAt，只有状态变更才补时间 + 写流水
    let app = await http('POST', '/api/applications', {
      position: job.position,
      companyId,
      jdId: jdRow.id,
      resumeId: RESUME_ID,
      status: 'interested',
      followUpAfterDays: 5,
      payload: {
        jdText: job.jdText,
        jdUrl: job.meta.jdUrl,
        jdSource: job.meta.source,
        channel: job.meta.channel,
        department: job.meta.department,
        city: job.meta.city,
        location: job.meta.location,
        employmentType: job.meta.employmentType,
        experience: job.meta.experience,
        education: job.meta.education,
        publishDate: job.meta.publishDate || '',
        publishDateNote: job.meta.publishDateNote,
        updatedDate: job.meta.updatedDate || '',
        externalJobId: job.meta.externalJobId || '',
        jobCode: job.meta.jobCode || '',
        skills: job.meta.skills,
        duties: job.duties,
        requirements: job.requirements,
        bonus: job.bonus,
        companyName: company?.name,
        stage: job.meta.stage || '',
        capturedAt: '2026-11-09',
      },
    });
    app = await http('PUT', `/api/applications/${app.id}`, { status: 'applied' });
    console.log(`  ✓ 投递记录: ${job.position} (${app.id}) → applied`);
  }

  // 3) 汇总
  const finalApps = await http('GET', '/api/applications');
  const finalCos = await http('GET', '/api/companies');
  console.log('\n=== 完成 ===');
  console.log(`公司总数 ${finalCos.length} / 岗位总数 ${finalApps.length}`);
  for (const c of COMPANIES) {
    const id = companyIds[c.key];
    const jds = await http('GET', `/api/companies/${id}/jds`);
    const mine = finalApps.filter((a) => a.companyId === id);
    console.log(`  ${c.name}: JD ${jds.length} 个, 岗位 ${mine.length} 个`);
    mine.forEach((a) => console.log(`    - ${a.position} [${a.status}] ${a.appliedAt || ''}`));
  }
  console.log(`关联简历 ${RESUME_ID}: ${finalApps.filter((a) => a.resumeId === RESUME_ID).length} 个岗位`);
}

main().catch((e) => {
  console.error('导入失败:', e.message || e);
  process.exit(1);
});
