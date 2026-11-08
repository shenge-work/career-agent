/**
 * 从 Chrome 遗留的招聘标签页导入 JD / 投递记录 / 公司档案。
 *
 * 走本地正式 HTTP API（POST /api/companies、/companies/:id/jds、/api/applications），
 * 因此 0010~0011 的触发器、application_events 状态流水、change_log 增量都会正常写入，
 * 不走直连 PGlite（dev 在跑时直连同一 pgdata 会抢写）。
 *
 * 数据源：用户 Chrome 中 5 个招聘 JD 标签页，均已确认投递。
 * 幂等：公司按名称匹配、岗位按 (companyId, position) 匹配、JD 按 (companyId, title) 匹配。
 *
 * 用法：node scripts/import-chrome-jds.js
 */

const BASE = process.env.CA_BASE || 'http://127.0.0.1:3000';

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

const VIPSHOP_JD = `职位描述

岗位职责
1、负责 AI Agent、DevOps 流程等质量相关效能工具与平台的设计、开发工作；
2、推动工具最佳实践落地与推广，持续提升研发体系的质量与交付效率；
3、深入理解产研交付全流程，识别流程痛点，输出优化方案并推动落地。

岗位要求
1、计算机相关专业，3 年及以上开发经验；
2、具备扎实的全栈开发能力，了解 AI Agent 设计与构建范式，有 Agent 落地实践优先；
3、熟悉产研 DevOps 完整流程，了解各类开源效能工具，具备开阔的工具生态视野；
4、有效能工具平台、插件工具或其他复杂系统的开发落地经验优先；
5、具备良好数据分析能力、问题解决能力与沟通协作能力；有工具类产品运营、推广经验优先。

职位信息
发布日期：2026-08-26
所属部门：产品技术中心
工作地点：广东·广州市
职位性质：全职
工作经验：不限`;

const XTOOL_EVAL_JD = `一、岗位简介
负责搭建 AI 能力的评测与治理体系。主要做三件事：
- 评测：定一套各 AI 能力通用的指标，建评测集，让模型每次更新都能自动回归、和旧版本对比。
- 自治等级：定 AI 能自己做主到哪一步。从只给信息、给建议，到人确认后执行、低风险时自动执行，再到有安全系统兜底时连续自动运行，分成几档。档位按场景的风险来定，同一个 AI 能力在不同场景可以处在不同档。
- 准入与追溯：定每一档上线要满足的门槛，建立模型卡、审计日志和事故记录，让 AI 的上线和降级都有据可查。
我们的 AI 会直接影响真实加工，出了错往往没法撤销，所以门槛要比纯软件 AI 更严。

二、岗位职责
这个岗位负责定标准、做评测、判断能不能上线。
1. 统一指标：定各 AI 能力的指标，如：做得对不对（效能）、模型说有把握时是不是真的准（可信）、遇到没学过的输入能不能察觉（边界）、有没有做出危险动作（安全）、时延和成本（运行）。每个指标写清怎么算、线上要采哪些数据。
2. 自主等级规范：按出错后果多严重、能不能撤销、能不能及时发现三点给场景评风险，再由风险定出 AI 最多能自主到哪一档。把现有 AI 场景逐个定档，整理成对照表，并列出哪些动作必须等人确认才能执行。
3. 评测集与回归报告：按业务方向（加工方案规划、视觉检测、安全检测等）分别建评测集，写清怎么构造、怎么分层抽样，每份都有版本。罕见和危险的情况用仿真数据补。模型每改一版自动跑，出新旧版本对比报告，指标汇总到看板上。
4. 模型卡与上线门槛：定模型卡的格式，写清用途、训练数据来源、能力边界、已知会出错的情况、评测结果、授权到哪一档、谁负责，每个上线的能力都要登记。定每一档上线要交哪些证据、谁来判。
5. 红队测试：针对加工场景整理测试方法，积累用例库，测 AI 会不会越权、参数越界、绕过用户确认、被提示注入，遇到没见过的材料或图形时会不会出错。

三、任职要求
1. 3 年以上 AI/ML 工程、算法质量或模型评测相关经验，完整参与过模型从训练到上线到迭代的全过程。
2. Python 扎实，做过需要长期维护的评测或数据链路。
3. 系统评测过至少一类模型（视觉检测、回归预测、LLM Agent 均可），清楚评测集怎么抽样、基线怎么定、误报和漏报怎么取舍。
4. 理解不确定性量化：知道置信度校准（ECE、温度缩放）与 OOD 检测在解决什么问题，以及它们在小样本下的失效方式。
5. 能把技术判断沉淀为团队共识：等级定义、指标口径、证据清单这类标准，你定完是要让其他团队看懂、认可并照着执行的，因此需要清晰的表达与推动力。
6. 能接受评测的最终裁决来自物理世界：一次判定对不对，要靠一次真实加工来验证。这意味着评测周期以小时计、单个样本的成本是材料和机时，评测集设计必须在统计效力和实验成本之间做取舍——这和跑一遍软件基准测试是两种工作方式。
7. 有卓越工程意识：对产品体验有追求，对工程实现有品味，不将就平庸的方案；有持续发现问题、持续优化系统的内驱力。

四、加分项
1. 在自动驾驶、工业机器人、医疗 AI 或金融风控这类高风险领域做过模型评测或分级授权。
2. 做过 LLM / Agent 的评测和红队测试。
3. 有把评测接入 CI、回归不通过即阻断发布的落地经验。
4. 有制造、工业软件、CAD/CAM 或机器人相关背景。
5. 了解 NIST AI RMF、ISO/IEC 42001 或 EU AI Act 对高风险 AI 系统的要求。`;

const XTOOL_ARCH_JD = `岗位定位
负责公司智能设备软件平台的中长期技术架构演进与前沿技术探索，关注 AI、Agent、系统软件、Runtime、工作流、编译技术、边缘计算等方向的发展，并推动有长期价值的技术从探索验证走向平台和产品落地。
我们希望你不只能理解新技术，更能够判断哪些技术值得长期投入、哪些能力应该沉淀为平台基础设施，并推动复杂专业能力在不同产品和业务之间形成复用。
这是一个偏系统架构与技术前瞻的岗位，不是单纯的业务架构或 AI 应用岗位。

核心职责
- 参与智能设备软件平台的整体架构设计与中长期演进
- 跟踪并研究 AI、Agent、Runtime、Workflow、Compiler、边缘计算等前沿技术方向
- 识别具有长期价值的技术机会，并推动原型验证、架构设计和工程落地
- 参与跨设备、跨平台公共能力的抽象与平台化建设
- 推动专业领域能力形成稳定、可复用、可扩展的软件能力
- 与 AI、算法、3D、图形、色彩、嵌入式、云平台等团队协作，定义合理的系统边界与协作方式
- 参与重大技术方案评审及复杂系统问题分析
- 推动架构规范、技术标准、技术雷达及技术决策机制建设
- 在关键方向上能够深入代码和实现，推动架构真正落地

任职要求
- 8 年以上软件开发、系统软件或平台架构相关经验
- 扎实的计算机系统基础，对操作系统、Runtime、分布式系统、编译技术、AI Infra 等至少一个领域有较深入积累
- 有大型软件平台、复杂系统或智能设备相关架构经验
- 对 AI、Agent、多模态、端侧智能等技术有较深入理解，能够理解其能力边界、工程约束和长期影响
- 具备优秀的系统抽象能力，能够从具体业务和产品问题中提炼稳定的共性机制
- 有较强的技术判断力，能够区分技术热点与真正具有长期价值的基础能力
- 能够兼顾前瞻性与工程落地，不停留在概念或架构图层
- 具备较强的跨团队沟通、推动与技术影响力

加分项（具备以下一项或多项经验优先）
- 操作系统、Runtime、中间件或系统软件
- AI Platform、Agent Platform、AI Infra
- Compiler / IR / DSL
- Edge AI / On-device AI
- Embedded Linux
- Graphics / 3D / Geometry Computing
- GPU / NPU / 异构计算
- Robotics / Drone / Automotive
- 智能硬件平台
- 插件系统、扩展 Runtime 或安全沙箱
- 从 Prototype 推进到真实产品或平台落地的经历`;

const PDD_AI_PLATFORM_JD = `岗位职责
1. 机器学习/AI平台产品研发，涉及资源调度、大数据处理、深度学习、在线/离线架构等；
2. 与算法工程师深入合作，探索前沿算法在各种业务场景的应用。

任职要求
1. 扎实的编程基础、良好的编程风格与工作习惯；
2. 熟练掌握一种静态语言（Go/C++/Java/C#等）；
3. 熟悉至少一种动态语言（Python/Perl/Ruby/Javascript等）；
4. 具有良好的产品意识，重视用户体验；
5. 具有独立解决问题的能力，良好的团队合作意识和沟通能力；

加分项
1. 好奇心强，热爱技术且对特定领域有深入钻研；
2. 有直接面向用户的产品开发经验；
3. 有分布式系统开发经验；
4. 熟悉主流深度学习编程框架（TensorFlow/Caffe/MXNet），熟悉其底层架构和实现机制；
5. 熟悉常用的机器学习算法（SparseLR/FFM/DNN/RNN）；`;

const PDD_AGENT_JD = `岗位职责
1、负责搜索推荐广告业务智能体（Agent）平台的架构设计与核心开发，支持 AIGC、样本生成、数据分析、效果归因、算法自动研究、智能监控等场景；
2、设计并实现智能体编排引擎，支持多智能体协作、工具调用、任务规划与执行的自动化流程；
3、构建工具生态系统，封装数据查询、实验平台、监控告警、代码执行等能力为标准化工具接口，供智能体调用；
4、开发智能体记忆系统和上下文管理模块，支持长对话、多轮交互和历史知识复用；
5、建设 LLM 推理服务和 Prompt 工程基础设施，优化智能体推理性能和成本；
6、实现安全沙箱环境，支持智能体自动生成和执行代码（SQL、Python 等）的安全隔离；
7、搭建智能体评估体系和可观测性平台，监控智能体执行质量、成功率和资源消耗；
8、支持 Agentic RL（智能体强化学习）训练基础设施，包括环境模拟、奖励设计、策略优化的工程化支持。

任职要求
1、本科及以上学历，计算机相关专业，3 年以上后端开发经验；
2、精通 Python/Java/Go 等至少一门语言，有分布式系统、微服务架构实践经验；
3、熟悉 LangChain、LlamaIndex、AutoGPT、MetaGPT 等智能体框架，或有类似系统开发经验；
4、了解主流 LLM（GPT-4、Claude、通义千问等）的 API 使用和 Prompt Engineering；
5、有数据平台、BI 系统、实验平台或监控系统开发经验者优先；
6、了解强化学习基础概念，有 RL 训练平台或在线学习系统开发经验者优先；
7、熟悉容器化（Docker/K8s）、消息队列、任务调度系统者优先；
8、具备良好的系统设计能力，能独立负责复杂智能体系统的架构和落地；
9、对 AI 技术有热情，愿意探索 LLM 和智能体在业务场景的创新应用。

加分项
无`;

/** 三家公司档案：payload 对齐 normalizeCompany（industry/scale/location/website/summary/research/tags...） */
const COMPANIES = [
  {
    key: 'vipshop',
    name: '唯品会（中国）有限公司',
    payload: {
      industry: '电子商务/品牌特卖',
      industryCategory: 'net-ecom',
      industryAliases: ['电商', '特卖', '零售', '品牌折扣'],
      scale: '10000人以上',
      location: '广州·荔湾区',
      website: 'https://www.vip.com',
      careersUrl:
        'https://app-tc.mokahr.com/recommendation-recruitment/vipshophr/10040?recommendCode=NTAArsF',
      tags: ['特卖电商', '中概股', '内推'],
      summary:
        '唯品会（Vipshop，NYSE: VIPS）2008 年成立于广州，是国内品牌特卖电商平台，以「品牌折扣 + 限时特卖」为核心模式，自营采买并自建仓储物流，品类覆盖服饰鞋包、美妆、母婴、家居、3C。招聘走 Moka 内推系统（app-tc.mokahr.com）。',
      note: 'JD 与公司信息据唯品会 Moka 内推页公开招聘信息整理（2026-11-09 采集）。',
      research: [
        {
          dim: '公司简介',
          platform: 'Moka 内推页',
          content:
            '产品技术中心下设效能工程方向，负责 AI Agent 与 DevOps 质量效能工具/平台的设计与研发，服务产研交付全流程。',
          date: '2026-11-09',
          url: 'https://app-tc.mokahr.com/recommendation-recruitment/vipshophr/10040',
        },
      ],
    },
  },
  {
    key: 'xtool',
    name: 'xTool',
    payload: {
      industry: '智能硬件/消费电子（激光雕刻设备）',
      industryCategory: 'hw-smart',
      industryAliases: ['智能硬件', '激光雕刻', '消费电子', '硬件'],
      scale: '1000-9999人',
      location: '深圳·南山区',
      website: 'https://www.xtool.com',
      careersUrl: 'https://xtool.jobs.feishu.cn',
      summary:
        'xTool 是深圳市创客工场科技（Makeblock）旗下激光雕刻与消费级智能硬件品牌，产品线含激光雕刻机、切割机及配套软件生态（xTool Creative Space），面向全球 DIY 与小批量加工用户，海外收入占比高；软件平台方向涉及 AI/Agent、Runtime、边缘计算与图形几何计算。',
      note: 'JD 与公司信息据 xTool 飞书内推页公开招聘信息整理（2026-11-09 采集）。',
      research: [
        {
          dim: '公司简介',
          platform: 'xTool 内推页（飞书招聘）',
          content:
            '智能设备软件平台团队负责中长期技术架构演进与前沿技术探索，方向覆盖 AI、Agent、系统软件、Runtime、工作流、编译技术、边缘计算；业务侧同时在做加工场景的 AI 评测与治理体系。',
          date: '2026-11-09',
          url: 'https://xtool.jobs.feishu.cn',
        },
      ],
    },
  },
  {
    key: 'pdd',
    name: '拼多多（上海寻梦信息技术有限公司）',
    payload: {
      industry: '电子商务/电商平台',
      industryCategory: 'net-ecom',
      industryAliases: ['电商', '社交电商', '跨境电商', '零售'],
      scale: '10000人以上',
      location: '上海·长宁区',
      website: 'https://www.pinduoduo.com',
      careersUrl: 'https://careers.pddglobalhr.com',
      tags: ['社交电商', '跨境 Temu', '中概股'],
      summary:
        '拼多多（PDD Holdings，NASDAQ: PDD）2015 年上线，主营社交电商与农产品上行，另有跨境电商业务 Temu。研发类岗位集中在上海，招聘官网 careers.pddglobalhr.com（社招/校招分列，简历也可投 hr@pddglobalhr.com）。',
      note: 'JD 与公司信息据拼多多社招官网公开招聘信息整理（2026-11-09 采集）。',
      research: [
        {
          dim: '公司简介',
          platform: 'PDD 社招官网',
          content:
            '研发类岗位覆盖 AI 平台（资源调度、大数据处理、深度学习、在线/离线架构）与搜索推荐广告业务的智能体平台（Agentic AI Infrastructure：编排引擎、工具生态、记忆与上下文、推理服务、安全沙箱、评估与可观测）。',
          date: '2026-11-09',
          url: 'https://careers.pddglobalhr.com',
        },
      ],
    },
  },
];

/** 5 个 JD：全部已投递 */
const JOBS = [
  {
    companyKey: 'vipshop',
    title: '高级全栈开发工程师（工程效能）',
    city: '广州',
    department: '产品技术中心',
    employmentType: '全职',
    experience: '不限',
    postedAt: '2026-08-26',
    salary: '',
    url: 'https://app-tc.mokahr.com/recommendation-recruitment/vipshophr/10040?recommendCode=NTAArsF#/job/b8116aa5-422a-4893-b522-ad1568265b02',
    source: '唯品会 Moka 内推',
    channel: '内推',
    jdText: VIPSHOP_JD,
  },
  {
    companyKey: 'xtool',
    title: 'AI 工程师（评测与治理方向）',
    city: '深圳',
    department: '技术研发',
    employmentType: '全职',
    experience: '3 年以上',
    postedAt: '',
    salary: '',
    url: 'https://xtool.jobs.feishu.cn/referral/position/7694492329814280467/detail',
    source: 'xTool 飞书内推',
    channel: '内推',
    jdText: XTOOL_EVAL_JD,
  },
  {
    companyKey: 'xtool',
    title: '平台架构师',
    city: '深圳',
    department: '技术研发',
    employmentType: '全职',
    experience: '8 年以上',
    postedAt: '',
    salary: '',
    url: 'https://xtool.jobs.feishu.cn/referral/position/7694478072825645338/detail',
    source: 'xTool 飞书内推',
    channel: '内推',
    jdText: XTOOL_ARCH_JD,
  },
  {
    companyKey: 'pdd',
    title: 'AI平台',
    city: '上海',
    department: '研发类',
    employmentType: '全职',
    experience: '不限',
    postedAt: '2026-09-02',
    salary: '',
    url: 'https://careers.pddglobalhr.com/jobs/detail?code=T011894',
    source: 'PDD 社招官网',
    channel: '官网投递',
    jdText: PDD_AI_PLATFORM_JD,
  },
  {
    companyKey: 'pdd',
    title: '智能体平台工程师（Agentic AI Infrastructure）',
    city: '上海',
    department: '研发类',
    employmentType: '全职',
    experience: '3 年以上',
    postedAt: '2026-10-31',
    salary: '',
    url: 'https://careers.pddglobalhr.com/jobs/detail?code=T024108',
    source: 'PDD 社招官网',
    channel: '官网投递',
    jdText: PDD_AGENT_JD,
  },
];

async function main() {
  // 1) 开发免登录（仅 DEV_SKIP_AUTH=true 的本地 dev 服务可用）
  const login = await fetch(BASE + '/api/auth/dev-login', { method: 'POST' });
  if (!login.ok) throw new Error('dev-login 失败: ' + (await login.text()).slice(0, 200));
  const raw = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = raw.map((c) => String(c).split(';')[0]).join('; ');
  const me = await login.json();
  console.log(`✓ 会话建立: ${me.user.email} (${me.user.id})`);

  const companies = await http('GET', '/api/companies');
  const byName = new Map(companies.map((c) => [c.name.trim().toLowerCase(), c]));
  const companyIds = {};

  // 2) 公司档案：存在则合并 payload（保留原有字段），不存在则新建
  for (const c of COMPANIES) {
    const found = byName.get(c.name.trim().toLowerCase());
    if (found) {
      const merged = { ...(found.payload || {}), ...c.payload };
      merged.summary = c.payload.summary;
      merged.tags = [...new Set([...(found.payload?.tags || []), ...(c.payload.tags || [])])];
      merged.name = found.name;
      await http('PUT', `/api/companies/${found.id}`, { name: found.name, payload: merged });
      companyIds[c.key] = found.id;
      console.log(`✓ 复用公司并补全档案: ${found.name} (${found.id})`);
    } else {
      const created = await http('POST', '/api/companies', { name: c.name, payload: c.payload });
      companyIds[c.key] = created.id;
      console.log(`✓ 新建公司: ${created.name} (${created.id})`);
    }
  }

  // 3) 公司岗位 JD + 投递记录
  for (const job of JOBS) {
    const companyId = companyIds[job.companyKey];
    const company = COMPANIES.find((c) => c.key === job.companyKey);

    const jdPayload = {
      title: job.title,
      city: job.city,
      salary: job.salary || undefined,
      department: job.department,
      employmentType: job.employmentType,
      experience: job.experience,
      postedAt: job.postedAt || undefined,
      url: job.url,
      source: job.source,
      channel: job.channel,
      status: 'applied',
      jdText: job.jdText,
      capturedAt: '2026-11-09',
    };

    const existingJds = await http('GET', `/api/companies/${companyId}/jds`);
    let jdRow = existingJds.find((j) => String(j.payload?.title || '').trim() === job.title);
    if (jdRow) {
      console.log(`  已存在 JD，跳过: ${job.title}`);
    } else {
      jdRow = await http('POST', `/api/companies/${companyId}/jds`, { payload: jdPayload });
      console.log(`  ✓ 录入 JD: ${job.title} (${jdRow.id})`);
    }

    const apps = await http('GET', '/api/applications');
    let app = apps.find(
      (a) => a.companyId === companyId && String(a.position || '').trim() === job.title
    );

    if (app) {
      console.log(`  已存在投递，跳过: ${job.title} [${app.status}]`);
      continue;
    }

    // 先建「意向」再改「已投递」：服务层只在状态变更时写 appliedAt + 状态流水，
    // 这样时间线与投递时间才是真实的（createApplication 不会自动带 appliedAt）。
    app = await http('POST', '/api/applications', {
      position: job.title,
      companyId,
      jdId: jdRow.id,
      status: 'interested',
      followUpAfterDays: 5,
      payload: {
        jdText: job.jdText,
        jdUrl: job.url,
        jdSource: job.source,
        channel: job.channel,
        department: job.department,
        city: job.city,
        location: job.city,
        employmentType: job.employmentType,
        experience: job.experience,
        postedAt: job.postedAt || undefined,
        companyName: company?.name,
        salary: job.salary || undefined,
        capturedAt: '2026-11-09',
      },
    });
    app = await http('PUT', `/api/applications/${app.id}`, { status: 'applied' });
    console.log(`  ✓ 投递记录: ${job.title} (${app.id}) → applied`);
  }

  // 4) 结果汇总
  const finalApps = await http('GET', '/api/applications');
  const finalCos = await http('GET', '/api/companies');
  console.log('\n=== 完成 ===');
  console.log(`公司总数 ${finalCos.length} / 岗位总数 ${finalApps.length}`);
  for (const c of COMPANIES) {
    const id = companyIds[c.key];
    const jds = await http('GET', `/api/companies/${id}/jds`);
    const mine = finalApps.filter((a) => a.companyId === id);
    console.log(`  ${c.name}: JD ${jds.length} 个, 岗位 ${mine.length} 个`);
  }
}

main().catch((e) => {
  console.error('导入失败:', e.message || e);
  process.exit(1);
});
