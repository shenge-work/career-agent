import { PGlite } from '@electric-sql/pglite';

async function main() {
  const db = new PGlite('./pgdata');
  await db.waitReady;
  const { rows } = await db.query(`
    SELECT id, position, status, payload FROM applications
    WHERE user_id = 'f0ac8fd4-cb00-4272-bd74-775d3a16b6df'
    ORDER BY status, position
  `);
  console.log(`共 ${rows.length} 个岗位`);
  console.log();
  for (const r of rows) {
    const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    const jd = p.jdText || '';
    const company = p.companyName || '';
    const status = r.status.padEnd(12, ' ');
    const comp = company.slice(0, 10).padEnd(10, ' ');
    const pos = r.position.slice(0, 25).padEnd(25, ' ');
    console.log(`${status} | ${comp} | ${pos} | JD: ${jd.length} 字符`);
  }
  process.exit(0);
}
main();
