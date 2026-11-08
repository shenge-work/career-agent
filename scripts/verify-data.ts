import { createDatabase } from '../src/server/db/client';
import * as schema from '../src/server/db/schema';
import { eq } from 'drizzle-orm';

async function main() {
  const dbHandle = await createDatabase('./pgdata');
  const { db } = dbHandle;
  
  const users = await db.select().from(schema.users);
  console.log('用户数:', users.length);
  
  const apps = await db.select().from(schema.applications)
    .where(eq(schema.applications.userId, users[0].id));
  console.log('岗位数:', apps.length);
  
  const companies = await db.select().from(schema.companies)
    .where(eq(schema.companies.userId, users[0].id));
  console.log('公司数:', companies.length);
  
  await dbHandle.close();
}

main().catch(console.error);
