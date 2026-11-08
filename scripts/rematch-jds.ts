import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';

async function main() {
  const db = new PGlite('./pgdata');
  await db.waitReady;

  const jds = JSON.parse(fs.readFileSync('/tmp/boss_jds_all.json', 'utf-8'));
  console.log(`读取到 ${jds.length} 个抓取的 JD`);

  const { rows } = await db.query(`
    SELECT id, position, payload FROM applications
    WHERE user_id = 'f0ac8fd4-cb00-4272-bd74-775d3a16b6df'
  `);
  console.log(`数据库中有 ${rows.length} 个岗位\n`);

  let updated = 0;
  for (const jd of jds) {
    // 用岗位名关键词匹配
    const titleKeywords = jd.title.replace(/[（）()【】\[\]\/\s]/g, '').slice(0, 8);

    const match = rows.find((r: any) => {
      const pos = r.position.replace(/[（）()【】\[\]\/\s]/g, '');
      return pos.includes(titleKeywords) || titleKeywords.includes(pos);
    });

    if (match) {
      const p = typeof match.payload === 'string' ? JSON.parse(match.payload) : match.payload;
      p.jdText = jd.jd;
      p.companyName = jd.company;
      await db.query(
        `UPDATE applications SET payload = $1 WHERE id = $2`,
        [JSON.stringify(p), match.id]
      );
      console.log(`✓ ${jd.company.padEnd(10, ' ')} | ${jd.title.slice(0, 25).padEnd(25, ' ')} | JD: ${jd.jd.length} 字符`);
      updated++;
    } else {
      console.log(`✗ 未匹配: ${jd.company} - ${jd.title.slice(0, 25)}`);
    }
  }

  console.log(`\n完成！共更新 ${updated} 个岗位`);
  process.exit(0);
}
main();
