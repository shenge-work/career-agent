/**
 * 岗位详情补录：把 Chrome 标签页里能读到的岗位信息全部结构化落库。
 *
 * 目标结构对齐库里已有的 SHEIN 那条 JD（jobCode/category/level/department/education/
 * experience/employmentType/publishDate/isUrgent/duties[]/requirements[]/bonus[]/skills[]/
 * jdSummary/companyInfo/recruiter/source），避免同一张表出现两套字段规范。
 *
 * 拆解 duties/requirements/bonus 不手抄：直接解析库里已存的 jdText 分段（少一次转录错字风险）。
 *
 * 用法：node scripts/enrich-job-details.js
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

/* ============================================================ JD 文本分段解析 */

const SECTION_MAP = [
  [['岗位职责', '工作职责', '核心职责', '职责描述'], 'duties'],
  [['任职要求', '岗位要求', '招聘要求', '任职资格', '职位要求'], 'requirements'],
  [['加分项', '加分'], 'bonus'],
  [['岗位简介', '岗位定位', '职位描述', '职位简介', '岗位描述'], 'intro'],
  [['职位信息', '基础信息'], 'info'],
];

/** "三、任职要求" / "加分项（具备以下一项或多项经验优先）" → "任职要求" / "加分项" */
function normalizeHeading(line) {
  return line
    .trim()
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, '')
    .replace(/[（(].*?[)）]\s*$/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function headingKey(line) {
  const h = normalizeHeading(line);
  for (const [names, key] of SECTION_MAP) if (names.includes(h)) return key;
  return null;
}

const ITEM_START = /^(\d+[、.．)）]|[-·•*]|[（(]\d+[)）])/;

function splitItems(lines) {
  const items = [];
  let cur = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (ITEM_START.test(line)) {
      if (cur.trim()) items.push(cur.trim());
      cur = line.replace(ITEM_START, '').trim();
    } else if (cur) {
      cur += ' ' + line;
    } else {
      cur = line;
    }
  }
  if (cur.trim()) items.push(cur.trim());
  return items.filter((x) => Boolean(x) && !/^(无|无。|—|$)$/.test(x));
}

function parseJd(jdText) {
  const sections = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (!current) return;
    sections[current] = (sections[current] || []).concat(buf);
    buf = [];
  };
  for (const line of String(jdText || '').split('\n')) {
    const key = line.trim() ? headingKey(line) : null;
    if (key) {
      flush();
      current = key;
    } else {
      buf.push(line);
    }
  }
  flush();

  const info = {};
  if (sections.info) {
    for (const line of sections.info) {
      const m = line.match(/^\s*([^：:]{2,8})[：:]\s*(.+?)\s*$/);
      if (m) info[m[1]] = m[2];
    }
  }

  const introText = (sections.intro || []).join('\n').trim();
  return {
    duties: splitItems(sections.duties || []),
    requirements: splitItems(sections.requirements || []),
    bonus: splitItems(sections.bonus || []),
    jdSummary: splitItems(sections.intro || []).join('；').slice(0, 200) || introText.slice(0, 200),
    info,
  };
}

/* ============================================================ 岗位元信息（页面可见内容） */

const JOBS = [
  {
    companyName: '唯品会（中国）有限公司',
    position: '高级全栈开发工程师（工程效能）',
    meta: {
      companyName: '唯品会（中国）有限公司',
      title: '高级全栈开发工程师（工程效能）',
      jobCode: '',
      externalJobId: 'b8116aa5-422a-4893-b522-ad1568265b02',
      recommendCode: 'NTAArsF',
      boardOrgId: '10040',
      category: '',
      level: '',
      department: '产品技术中心',
      education: '',
      experience: '不限',
      employmentType: '全职',
      city: '广州',
      location: '广东·广州市',
      headcount: '',
      salary: '',
      publishDate: '2026-08-26',
      isUrgent: false,
      recruiter: '',
      source: '唯品会 Moka 内推',
      sourcePlatform: 'Moka（app-tc.mokahr.com）社招内推',
      channel: '内推',
      jdUrl:
        'https://app-tc.mokahr.com/recommendation-recruitment/vipshophr/10040?recommendCode=NTAArsF#/job/b8116aa5-422a-4893-b522-ad1568265b02',
      skills: [
        'AI Agent',
        'DevOps',
        '全栈开发',
        '效能工具平台',
        '插件工具',
        '研发效能',
        '数据分析',
        '产研交付流程',
      ],
    },
  },
  {
    companyName: 'xTool',
    position: 'AI 工程师（评测与治理方向）',
    meta: {
      companyName: 'xTool',
      title: 'AI 工程师（评测与治理方向）',
      jobCode: '',
      externalJobId: '7694492329814280467',
      recommendCode: '',
      category: '技术研发',
      level: '',
      department: '技术研发',
      education: '',
      experience: '3 年以上',
      employmentType: '全职',
      city: '深圳',
      location: '深圳',
      headcount: '',
      salary: '',
      publishDate: '',
      publishDateNote: '内推页未展示发布时间（xTool 飞书招聘页仅显示城市/性质/部门与「已投递」）',
      isUrgent: false,
      recruiter: '',
      source: 'xTool 飞书内推',
      sourcePlatform: '飞书招聘（xtool.jobs.feishu.cn）社招内推',
      channel: '内推',
      jdUrl: 'https://xtool.jobs.feishu.cn/referral/position/7694492329814280467/detail',
      skills: [
        'AI 评测体系',
        '模型评测',
        '评测集设计',
        '回归报告',
        '自主等级/风险定档',
        '模型卡',
        '红队测试',
        'Prompt 注入',
        'Python',
        '视觉检测',
        'LLM Agent',
        '置信度校准 ECE',
        '温度缩放',
        'OOD 检测',
        'NIST AI RMF',
        'ISO/IEC 42001',
        'EU AI Act',
      ],
    },
  },
  {
    companyName: 'xTool',
    position: '平台架构师',
    meta: {
      companyName: 'xTool',
      title: '平台架构师',
      jobCode: '',
      externalJobId: '7694478072825645338',
      recommendCode: '',
      category: '技术研发',
      level: '',
      department: '技术研发',
      education: '',
      experience: '8 年以上',
      employmentType: '全职',
      city: '深圳',
      location: '深圳',
      headcount: '',
      salary: '',
      publishDate: '',
      publishDateNote: '内推页未展示发布时间（xTool 飞书招聘页仅显示城市/性质/部门与「已投递」）',
      isUrgent: false,
      recruiter: '',
      source: 'xTool 飞书内推',
      sourcePlatform: '飞书招聘（xtool.jobs.feishu.cn）社招内推',
      channel: '内推',
      jdUrl: 'https://xtool.jobs.feishu.cn/referral/position/7694478072825645338/detail',
      skills: [
        '系统架构',
        '操作系统',
        'Runtime',
        '分布式系统',
        '编译技术',
        'AI Infra',
        'AI Platform',
        'Agent Platform',
        'Workflow',
        'Compiler / IR / DSL',
        '边缘计算',
        'Edge AI / On-device AI',
        'Embedded Linux',
        'Graphics / 3D / Geometry',
        'GPU / NPU 异构计算',
        '插件系统与安全沙箱',
        '技术雷达',
      ],
    },
  },
  {
    companyName: '拼多多（上海寻梦信息技术有限公司）',
    position: 'AI平台',
    meta: {
      companyName: '拼多多（上海寻梦信息技术有限公司）',
      title: 'AI平台',
      jobCode: 'T011894',
      externalJobId: 'T011894',
      recommendCode: '',
      category: '研发类',
      level: '',
      department: '研发类',
      education: '',
      experience: '',
      employmentType: '',
      city: '上海',
      location: '上海',
      headcount: '若干',
      salary: '',
      publishDate: '2026-09-02',
      isUrgent: false,
      recruiter: '',
      source: 'PDD 社招官网',
      sourcePlatform: 'PDD 社会招聘官网（careers.pddglobalhr.com）',
      channel: '官网投递',
      jdUrl: 'https://careers.pddglobalhr.com/jobs/detail?code=T011894',
      applyEmail: 'hr@pddglobalhr.com',
      applyNote: '简历也可投递到 hr@pddglobalhr.com；邮件/简历命名格式：【官网】岗位 - 姓名',
      skills: [
        '机器学习平台',
        'AI 平台',
        '资源调度',
        '大数据处理',
        '深度学习',
        '在线/离线架构',
        'Go',
        'C++',
        'Java',
        'C#',
        'Python',
        '分布式系统',
        'TensorFlow',
        'Caffe',
        'MXNet',
        'SparseLR',
        'FFM',
        'DNN',
        'RNN',
      ],
    },
  },
  {
    companyName: '拼多多（上海寻梦信息技术有限公司）',
    position: '智能体平台工程师（Agentic AI Infrastructure）',
    meta: {
      companyName: '拼多多（上海寻梦信息技术有限公司）',
      title: '智能体平台工程师（Agentic AI Infrastructure）',
      jobCode: 'T024108',
      externalJobId: 'T024108',
      recommendCode: '',
      category: '研发类',
      level: '',
      department: '研发类',
      education: '本科及以上',
      experience: '3 年以上',
      employmentType: '',
      city: '上海',
      location: '上海',
      headcount: '若干',
      salary: '',
      publishDate: '2026-10-31',
      isUrgent: false,
      recruiter: '',
      source: 'PDD 社招官网',
      sourcePlatform: 'PDD 社会招聘官网（careers.pddglobalhr.com）',
      channel: '官网投递',
      jdUrl: 'https://careers.pddglobalhr.com/jobs/detail?code=T024108',
      applyEmail: 'hr@pddglobalhr.com',
      applyNote: '简历也可投递到 hr@pddglobalhr.com；邮件/简历命名格式：【官网】岗位 - 姓名',
      skills: [
        'Agent 平台',
        '智能体编排引擎',
        '多智能体协作',
        '工具生态',
        '记忆与上下文管理',
        'LLM 推理服务',
        'Prompt Engineering',
        '安全沙箱',
        '可观测性',
        'Agentic RL',
        'LangChain',
        'LlamaIndex',
        'AutoGPT',
        'MetaGPT',
        'Python',
        'Java',
        'Go',
        'Docker / K8s',
        '消息队列',
        '任务调度',
      ],
    },
  },
  {
    // SHEIN 此前已录入（JD 结构已是目标规范），这里只补「发布时间」等页面上有、库里缺的字段
    companyName: 'SHEIN',
    position: 'AI Infra后台开发',
    meta: {
      companyName: 'SHEIN',
      title: 'AI Infra后台开发',
      jobCode: 'MJ016420',
      externalJobId: 'f90e766c-fabd-4f1c-9749-7523c614b5d4',
      recommendCode: 'NTAGB1P',
      boardOrgId: '2934',
      category: '信息技术类',
      level: 'S序列-S6',
      department: '产品研发中心',
      education: '本科',
      experience: '3年以上',
      employmentType: '全职',
      city: '广州/南京',
      location: '广东·广州市 江苏·南京市',
      headcount: '',
      salary: '',
      publishDate: '2026-09-14',
      isUrgent: true,
      recruiter: 'Yummy Liao（内推分享人）',
      source: 'SHEIN内部推荐',
      sourcePlatform: 'Moka（app.mokahr.com）社招内推海报',
      channel: '内推',
      jdUrl:
        'https://app.mokahr.com/recommendation-apply/shein/2934?sharePageId=4821962&recommendCode=NTAGB1P&codeType=1#/job/f90e766c-fabd-4f1c-9749-7523c614b5d4',
      skills: [
        'LLM 网关',
        'LiteLLM',
        'OneAPI',
        'Claude Code',
        'Codex',
        'MCP',
        'Function Calling',
        'Prompt Engineering',
        'Agent',
        'Kafka',
        'Flink',
        'Spark',
        'ClickHouse',
        'Doris',
        'StarRocks',
        'Python',
        'Java',
        'CI/CD',
        'Benchmark',
        'Eval Pipeline',
      ],
    },
  },
];

function companyInfoLine(m) {
  return [
    m.companyName,
    m.isUrgent ? '社招急招' : '社招内推',
    m.level || null,
    m.department || null,
    m.category || null,
    m.jobCode || null,
    m.publishDate ? `发布 ${m.publishDate}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

async function main() {
  const login = await fetch(BASE + '/api/auth/dev-login', { method: 'POST' });
  if (!login.ok) throw new Error('dev-login 失败: ' + (await login.text()).slice(0, 200));
  const raw = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = raw.map((c) => String(c).split(';')[0]).join('; ');

  const apps = await http('GET', '/api/applications');
  const companies = await http('GET', '/api/companies');
  const byName = new Map(companies.map((c) => [String(c.name || '').trim().toLowerCase(), c]));

  for (const job of JOBS) {
    const m = job.meta;
    // 公司 id 按名字解析：数据库回退/重建后 id 会变，写死 id 会让脚本静默失配。
    const company = byName.get(job.companyName.trim().toLowerCase());
    if (!company) {
      console.log(`✗ 未找到公司: ${job.companyName}`);
      continue;
    }
    const companyId = company.id;
    const app = apps.find(
      (a) => a.companyId === companyId && String(a.position || '').trim() === job.position
    );
    if (!app) {
      console.log(`✗ 未找到投递记录: ${m.companyName} · ${job.position}`);
      continue;
    }

    const parsed = parseJd(app.payload?.jdText || '');

    // ---------- 1) 公司 JD（规范结构，作为唯一权威 JD 记录）
    const jds = await http('GET', `/api/companies/${companyId}/jds`);
    let jdRow = jds.find((j) => String(j.payload?.title || '').trim() === job.position);

    const jdPayload = {
      title: m.title,
      jobCode: m.jobCode,
      externalJobId: m.externalJobId,
      recommendCode: m.recommendCode,
      boardOrgId: m.boardOrgId || '',
      category: m.category,
      level: m.level,
      city: m.city,
      department: m.department,
      education: m.education,
      experience: m.experience,
      employmentType: m.employmentType,
      headcount: m.headcount,
      salary: m.salary,
      publishDate: m.publishDate,
      publishDateNote: m.publishDateNote || '',
      isUrgent: m.isUrgent,
      recruiter: m.recruiter,
      duties: parsed.duties,
      requirements: parsed.requirements,
      bonus: parsed.bonus,
      benefits: [],
      skills: m.skills,
      jdSummary: parsed.jdSummary,
      infoFields: parsed.info,
      companyInfo: companyInfoLine(m),
      source: m.source,
      sourcePlatform: m.sourcePlatform,
      url: m.jdUrl,
      capturedAt: '2026-11-09',
    };

    if (jdRow) {
      jdRow = await http('PUT', `/api/companies/${companyId}/jds/${jdRow.id}`, { payload: jdPayload });
      console.log(`✓ 更新 JD: ${m.companyName} · ${job.position}`);
    } else {
      jdRow = await http('POST', `/api/companies/${companyId}/jds`, { payload: jdPayload });
      console.log(`✓ 新建 JD: ${m.companyName} · ${job.position}`);
    }
    console.log(
      `   职责 ${parsed.duties.length} 条 / 要求 ${parsed.requirements.length} 条 / 加分 ${parsed.bonus.length} 条 / 技能 ${m.skills.length} 个 / 发布 ${m.publishDate || '页面未展示'}`
    );

    // ---------- 2) 投递记录（展示 + 检索所需字段）
    const appPayload = {
      ...(app.payload || {}),
      jdId: jdRow.id,
      jdText: app.payload?.jdText || '',
      jdSummary: parsed.jdSummary,
      jdUrl: m.jdUrl,
      jdSource: m.source,
      sourcePlatform: m.sourcePlatform,
      channel: m.channel,
      companyName: m.companyName,
      jobCode: m.jobCode,
      externalJobId: m.externalJobId,
      recommendCode: m.recommendCode,
      category: m.category,
      level: m.level,
      department: m.department,
      education: m.education,
      experience: m.experience,
      employmentType: m.employmentType,
      city: m.city,
      location: m.location,
      headcount: m.headcount,
      salary: m.salary,
      publishDate: m.publishDate,
      publishDateNote: m.publishDateNote || '',
      isUrgent: m.isUrgent,
      recruiter: m.recruiter,
      skills: m.skills,
      applyEmail: m.applyEmail || '',
      applyNote: m.applyNote || '',
      capturedAt: '2026-11-09',
    };
    await http('PUT', `/api/applications/${app.id}`, { payload: appPayload, jdId: jdRow.id });
    console.log(`   ✓ 投递记录回填 ${app.id}（发布时间 ${m.publishDate || '—'}）`);
  }

  console.log('\n=== 完成 ===');
}

main().catch((e) => {
  console.error('补录失败:', e.message || e);
  process.exit(1);
});
