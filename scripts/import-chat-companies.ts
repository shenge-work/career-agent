/**
 * 批量导入 BOSS直聘聊天列表中的公司到公司档案
 */
import { createDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema';
import { eq } from 'drizzle-orm';

// 聊天列表中的所有公司（去重后）
const CHAT_COMPANIES = [
  '京东零售',
  '传音控股',
  '平安科技',
  '万兴科技',
  '三一重工',
  '深圳传申弘安智能',
  '文德数慧',
  '优必选机器人',
  '金蝶软件',
  '蕉下',
  '腾讯',
  '黑白调集团',
  '宁德时代新能源',
  '亚朵集团',
  '同花顺',
  '帕西尼感知科技',
  '沃尔玛中国',
  '赢时胜',
  '拓竹科技',
  '迈瑞医疗',
  '天职国际',
  'Manus AI',
  '普渡机器人',
  '道通科技',
  '盈米基金',
  '虎一科技',
  '大疆创新',
  '深圳新辰知序科技',
  '百度',
  '超威半导体',
  '吉翼智能',
  'Anker安克创新',
  '深亚达',
  '合生和',
  '想向着陆',
  '丹霄技术',
  '位来小猎',
];

async function main() {
  console.log('连接数据库...');
  const dbHandle = await createDatabase('./pgdata');
  const db = dbHandle.db || dbHandle;

  // 获取当前用户
  const users = await db.select().from(schema.users);
  const userId = users[0].id;
  console.log(`✓ 当前用户: ${users[0].email} (${userId})`);

  // 获取已有公司
  const existing = await db.select().from(schema.companies)
    .where(eq(schema.companies.userId, userId));
  const existingNames = new Set(existing.map((c: any) => c.name));
  console.log(`已有公司: ${existing.length} 家`);

  let created = 0;
  let skipped = 0;

  for (const name of CHAT_COMPANIES) {
    if (existingNames.has(name)) {
      skipped++;
      continue;
    }

    await db.insert(schema.companies).values({
      id: `boss_chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      name,
      payload: {
        source: 'BOSS直聘聊天列表',
        importedAt: new Date().toISOString(),
      },
    });

    created++;
    console.log(`✓ 创建: ${name}`);
  }

  console.log(`\n=== 导入完成 ===`);
  console.log(`新建: ${created} 家`);
  console.log(`跳过: ${skipped} 家（已存在）`);

  // 查看总数
  const all = await db.select().from(schema.companies)
    .where(eq(schema.companies.userId, userId));
  console.log(`公司档案总数: ${all.length} 家`);

  await dbHandle.close?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
