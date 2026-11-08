import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';

async function main() {
  const db = new PGlite('./pgdata');
  await db.waitReady;

  // 读取抓取的 JD 数据
  const jds = JSON.parse(fs.readFileSync('/tmp/boss_jds_all.json', 'utf-8'));
  console.log(`读取到 ${jds.length} 个 JD`);

  // 查询所有岗位
  const { rows } = await db.query(`
    SELECT id, position, payload FROM applications
    WHERE user_id = 'f0ac8fd4-cb00-4272-bd74-775d3a16b6df'
  `);

  console.log(`数据库中有 ${rows.length} 个岗位`);

  let updated = 0;
  for (const jd of jds) {
    // 按公司名+岗位名匹配
    const match = rows.find((r: any) => {
      const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      const companyName = p.companyName || '';
      // 模糊匹配
      const companyMatch = companyName.includes(jd.company.slice(0, 4)) || jd.company.includes(companyName.slice(0, 4));
      const positionMatch = r.position.includes(jd.title.slice(0, 6)) || jd.title.includes(r.position.slice(0, 6));
      return companyMatch && positionMatch;
    });

    if (match) {
      const p = typeof match.payload === 'string' ? JSON.parse(match.payload) : match.payload;
      p.jdText = jd.jd;
      await db.query(
        `UPDATE applications SET payload = $1 WHERE id = $2`,
        [JSON.stringify(p), match.id]
      );
      console.log(`✓ 更新: ${jd.company} - ${jd.title.slice(0, 20)} (${jd.jd.length}字符)`);
      updated++;
    } else {
      console.log(`✗ 未匹配: ${jd.company} - ${jd.title.slice(0, 20)}`);
    }
  }

  console.log(`\n完成！共更新 ${updated} 个岗位的 JD`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
