import { PGlite } from '@electric-sql/pglite';

async function main() {
  const pg = new PGlite('./pgdata');
  await pg.waitReady;

  // 查询公司表结构
  const cols = await pg.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'companies'
    ORDER BY ordinal_position
  `);
  console.log('=== companies 表字段 ===');
  for (const c of cols.rows) {
    console.log(`  ${c.column_name}: ${c.data_type}`);
  }

  // 查询前5家公司的数据
  const result = await pg.query(`
    SELECT id, name, industry, size, funding, location, 
           LEFT(payload::text, 200) as payload_preview
    FROM companies 
    LIMIT 5
  `);
  console.log('\n=== 前5家公司数据 ===');
  for (const r of result.rows) {
    console.log(`\n公司: ${r.name}`);
    console.log(`  industry: ${r.industry}`);
    console.log(`  size: ${r.size}`);
    console.log(`  funding: ${r.funding}`);
    console.log(`  location: ${r.location}`);
    console.log(`  payload前200字符: ${r.payload_preview}`);
  }

  await pg.close();
}

main().catch(console.error);
