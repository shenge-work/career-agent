/**
 * 列出所有缺少公司简介的公司
 */
import { createDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema';
import { eq } from 'drizzle-orm';

async function main() {
  const dbHandle = await createDatabase('./pgdata');
  const db = dbHandle.db || dbHandle;

  const users = await db.select().from(schema.users);
  const userId = users[0].id;

  const companies = await db.select().from(schema.companies)
    .where(eq(schema.companies.userId, userId));

  const noIntro: string[] = [];
  const withIntro: string[] = [];

  for (const c of companies) {
    const payload = (c as any).payload || {};
    const research = payload.research || [];
    const hasIntro = research.some((r: any) => r.dim === '公司简介');
    if (hasIntro) {
      withIntro.push(c.name);
    } else {
      noIntro.push(c.name);
    }
  }

  console.log('已有简介 (' + withIntro.length + '):');
  withIntro.forEach(n => console.log('  ✓ ' + n));
  console.log();
  console.log('缺少简介 (' + noIntro.length + '):');
  noIntro.forEach(n => console.log('  ✗ ' + n));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
