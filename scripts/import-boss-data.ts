/**
 * BOSS直聘数据导入脚本
 * 从抓取的聊天记录和投递记录中导入到 CareerAgent 数据库
 */
import { createDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema';
import { eq } from 'drizzle-orm';

// 从BOSS直聘抓取的已投递职位数据
const BOSS_APPLIED_DATA = [
  {
    company: '合生和',
    position: 'AI 应用开发工程师',
    salary: '25-35K',
    location: '深圳·南山区·科技园',
    status: 'rejected', // 职位已关闭
    contact: '罗女士',
    contactTitle: '人事主管',
    source: 'BOSS直聘',
  },
  {
    company: '文德数慧',
    position: '全栈开发工程师',
    salary: '15-30K',
    location: '深圳·南山区·科技园',
    status: 'applied',
    contact: '左女士',
    contactTitle: '招聘专员',
    source: 'BOSS直聘',
  },
  {
    company: '腾讯',
    position: 'MaaS平台后台开发工程师',
    salary: '20-35K·14薪',
    location: '深圳·南山区·科技园',
    status: 'applied',
    contact: '崔女士',
    contactTitle: '招聘者',
    source: 'BOSS直聘',
  },
  {
    company: '黑白调集团',
    position: '全栈开发工程师（AI 提效/Shopify）',
    salary: '25-40K·13薪',
    location: '深圳·南山区·科技园',
    status: 'applied',
    contact: '李请',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: '京东集团',
    position: 'Java开发工程师',
    salary: '40-70K·20薪',
    location: '北京·大兴区·亦庄',
    status: 'rejected',
    contact: '尚寿军',
    contactTitle: '架构师',
    source: 'BOSS直聘',
  },
  {
    company: '大疆创新',
    position: 'Java开发工程师（大疆驻场-AI Coding方向）',
    salary: '14-24K',
    location: '深圳·南山区·科技园',
    status: 'applied',
    contact: '蒋女士',
    contactTitle: '人才经纪人',
    source: 'BOSS直聘',
  },
  {
    company: '家乡互动',
    position: '高级全栈工程师',
    salary: '30-40K·14薪',
    location: '深圳·南山区·蛇口',
    status: 'applied',
    contact: '黄女士',
    contactTitle: '招聘者',
    source: 'BOSS直聘',
  },
  {
    company: '深圳市广和通',
    position: 'AI Native 全栈工程师',
    salary: '20-30K·15薪',
    location: '深圳·南山区·科技园',
    status: 'rejected',
    contact: '刘女士',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: '京东零售',
    position: 'Java开发工程师',
    salary: '30-50K',
    location: '深圳·南山区·科技园',
    status: 'rejected',
    contact: '陈科宇',
    contactTitle: '招聘者',
    source: 'BOSS直聘',
  },
  {
    company: 'Anker',
    position: '全栈开发工程师（AI 工程方向）',
    salary: '30-60K·16薪',
    location: '深圳·宝安区·西乡',
    status: 'applied',
    contact: '李女士',
    contactTitle: '招聘者',
    source: 'BOSS直聘',
  },
  {
    company: '腾展科技',
    position: 'AI Agent开发工程师',
    salary: '25-40K',
    location: '杭州·西湖区·文一路',
    status: 'applied',
    contact: '严女士',
    contactTitle: 'HRD',
    source: 'BOSS直聘',
  },
  {
    company: '360集团',
    position: '国际化-全栈开发',
    salary: '30-45K·15薪',
    location: '北京',
    status: 'rejected',
    contact: '刘畅',
    contactTitle: '招聘经理',
    source: 'BOSS直聘',
  },
  {
    company: 'Yarbo',
    position: '软件研发总监',
    salary: '30-40K',
    location: '深圳·龙华区·民治',
    status: 'applied',
    contact: '陈泳琼',
    contactTitle: '招聘负责人',
    source: 'BOSS直聘',
  },
  // 沟通过但未投递的职位（interested 状态）
  {
    company: '传音控股',
    position: 'Java研发工程师（新零售数字化方向）',
    salary: '20-35K',
    location: '深圳',
    status: 'interested',
    contact: '武先生',
    contactTitle: '新零售交易域研发负责人',
    source: 'BOSS直聘',
  },
  {
    company: '平安科技',
    position: 'Agent智能体平台研发工程师',
    salary: '25-40K·16薪',
    location: '深圳·南山区·科技园',
    status: 'interested',
    contact: '刘先生',
    contactTitle: '招聘者',
    source: 'BOSS直聘',
  },
  {
    company: '万兴科技',
    position: '全栈开发工程师',
    salary: '23-30K·15薪',
    location: '杭州·西湖区·文二路',
    status: 'interested',
    contact: '何林晓',
    contactTitle: 'HRBP',
    source: 'BOSS直聘',
  },
  {
    company: '三一重工',
    position: 'Java工程师',
    salary: '20-35K·16薪',
    location: '深圳·福田区·会展中心',
    status: 'interested',
    contact: '张女士',
    contactTitle: '招聘经理',
    source: 'BOSS直聘',
  },
  {
    company: '深圳传申弘安智能',
    position: 'Agent Harness智能体开发工程师',
    salary: '20-35K',
    location: '深圳·福田区·车公庙',
    status: 'interested',
    contact: '马先生',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: '优必选机器人',
    position: '高级Java开发工程师',
    salary: '20-40K',
    location: '深圳·南山区·西丽',
    status: 'interested',
    contact: '覃女士',
    contactTitle: '招聘经理',
    source: 'BOSS直聘',
  },
  {
    company: '金蝶软件中国',
    position: '后端开发工程师',
    salary: '20-40K',
    location: '深圳',
    status: 'interested',
    contact: '舒艳',
    contactTitle: '招聘者',
    source: 'BOSS直聘',
  },
  {
    company: '宁德新能源科技',
    position: 'AI Agent 开发工程师',
    salary: '25-40K·15薪',
    location: '深圳·南山区·科技园',
    status: 'interested',
    contact: '池小芳',
    contactTitle: '资深招聘HR',
    source: 'BOSS直聘',
  },
  {
    company: '亚朵集团',
    position: '资深Java开发工程师（会员方向）',
    salary: '30-45K·14薪',
    location: '上海·闵行区·虹桥',
    status: 'interested',
    contact: '刘女士',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: '同花顺',
    position: 'AI全栈工程师',
    salary: '25-50K·15薪',
    location: '杭州·余杭区·仓前',
    status: 'interested',
    contact: '王先生',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: '帕西尼感知科技',
    position: '全栈工程师',
    salary: '25-35K',
    location: '深圳·宝安区·西乡',
    status: 'interested',
    contact: '佟睿娉',
    contactTitle: '招聘人员',
    source: 'BOSS直聘',
  },
  {
    company: '沃尔玛(中国)',
    position: 'Java工程师（业财）',
    salary: '20-40K·13薪',
    location: '深圳',
    status: 'interested',
    contact: '翟女士',
    contactTitle: '资深招聘专员',
    source: 'BOSS直聘',
  },
  {
    company: '拓竹科技',
    position: '全栈开发工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '林碧君',
    contactTitle: '招聘HR',
    source: 'BOSS直聘',
  },
  {
    company: '迈瑞医疗',
    position: '应用开发资深工程师（Java）',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '李女士',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: 'Manus AI',
    position: 'AI Agent工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '蒋女士',
    contactTitle: 'Recruiter',
    source: 'BOSS直聘',
  },
  {
    company: '普渡机器人',
    position: '全栈开发工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '詹先生',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: '道通科技',
    position: '全栈开发工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '刘先生',
    contactTitle: '招聘经理',
    source: 'BOSS直聘',
  },
  {
    company: '盈米基金',
    position: 'Java开发工程师',
    salary: '面议',
    location: '广州',
    status: 'interested',
    contact: '王先生',
    contactTitle: '招聘专家',
    source: 'BOSS直聘',
  },
  {
    company: '虎一科技',
    position: '全栈开发工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '涂先生',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
  {
    company: '百度',
    position: 'Java开发工程师',
    salary: '面议',
    location: '北京',
    status: 'interested',
    contact: '喻先生',
    contactTitle: '招聘',
    source: 'BOSS直聘',
  },
  {
    company: '赢时胜',
    position: '后端开发工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '韦先生',
    contactTitle: '招聘总监',
    source: 'BOSS直聘',
  },
  {
    company: '蕉下',
    position: '全栈开发工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '田女士',
    contactTitle: '招聘专家',
    source: 'BOSS直聘',
  },
  {
    company: '深亚达',
    position: 'AI Agent工程师',
    salary: '面议',
    location: '深圳',
    status: 'interested',
    contact: '黄女士',
    contactTitle: 'HR',
    source: 'BOSS直聘',
  },
];

async function main() {
  console.log('=== BOSS直聘数据导入脚本 ===\n');

  // 连接数据库
  const dbHandle = await createDatabase('./pgdata');
  const { db } = dbHandle;
  console.log('✓ 数据库连接成功');

  // 获取用户ID
  const users = await db.select().from(schema.users);
  if (users.length === 0) {
    console.error('✗ 没有找到用户，请先登录系统创建用户');
    process.exit(1);
  }
  const userId = users[0].id;
  console.log(`✓ 当前用户: ${users[0].email} (${userId})`);

  // 导入公司数据
  console.log('\n--- 导入公司数据 ---');
  const companiesMap = new Map<string, string>(); // companyName -> companyId
  const uniqueCompanies = [...new Set(BOSS_APPLIED_DATA.map(d => d.company))];

  for (const companyName of uniqueCompanies) {
    // 检查是否已存在
    const existing = await db.select().from(schema.companies)
      .where(eq(schema.companies.userId, userId));

    const existingCompany = existing.find(c => c.name === companyName);
    if (existingCompany) {
      companiesMap.set(companyName, existingCompany.id);
      console.log(`  已存在: ${companyName}`);
      continue;
    }

    const companyId = `boss_${companyName.replace(/\s+/g, '_').toLowerCase()}`;
    await db.insert(schema.companies).values({
      id: companyId,
      userId,
      name: companyName,
      payload: {
        source: 'BOSS直聘',
        importedAt: new Date().toISOString(),
      },
    });
    companiesMap.set(companyName, companyId);
    console.log(`  ✓ 创建: ${companyName}`);
  }

  // 导入岗位数据
  console.log('\n--- 导入岗位数据 ---');
  let appliedCount = 0;
  let interestedCount = 0;
  let rejectedCount = 0;

  for (const item of BOSS_APPLIED_DATA) {
    const companyId = companiesMap.get(item.company);
    const appId = `boss_${item.company.replace(/\s+/g, '_').toLowerCase()}_${item.position.replace(/\s+/g, '_').slice(0, 30).toLowerCase()}`;

    // 检查是否已存在
    const existingApps = await db.select().from(schema.applications)
      .where(eq(schema.applications.userId, userId));

    if (existingApps.find(a => a.id === appId)) {
      console.log(`  已存在: ${item.company} - ${item.position}`);
      continue;
    }

    await db.insert(schema.applications).values({
      id: appId,
      userId,
      position: item.position,
      companyId: companyId || null,
      status: item.status as any,
      appliedAt: item.status === 'applied' || item.status === 'rejected' ? new Date() : null,
      payload: {
        source: 'BOSS直聘',
        salary: item.salary,
        location: item.location,
        contact: item.contact,
        contactTitle: item.contactTitle,
        importedAt: new Date().toISOString(),
      },
    });

    if (item.status === 'applied') appliedCount++;
    else if (item.status === 'interested') interestedCount++;
    else if (item.status === 'rejected') rejectedCount++;

    console.log(`  ✓ ${item.status === 'applied' ? '已投递' : item.status === 'interested' ? '意向' : '已拒绝'}: ${item.company} - ${item.position}`);
  }

  console.log('\n=== 导入完成 ===');
  console.log(`公司总数: ${uniqueCompanies.length}`);
  console.log(`岗位总数: ${BOSS_APPLIED_DATA.length}`);
  console.log(`  - 已投递: ${appliedCount}`);
  console.log(`  - 有意向: ${interestedCount}`);
  console.log(`  - 已拒绝: ${rejectedCount}`);

  await dbHandle.close();
  console.log('\n✓ 数据库连接已关闭');
}

main().catch(err => {
  console.error('导入失败:', err);
  process.exit(1);
});
