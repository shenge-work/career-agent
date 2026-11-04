import { defineConfig } from 'drizzle-kit';

/**
 * 基线迁移 drizzle/0000_init.sql 是手工维护的，且与 src/server/db/schema.ts 一一对应，
 * migrate.ts 只应用 drizzle/ 根目录下的 *.sql。
 *
 * 因此 generate 的输出单独放到 drizzle/generated/（被 .gitignore 忽略），
 * 后续改 schema 时先生成、人工审阅，再把需要的 SQL 移入 drizzle/ 才会真正生效。
 * 这样绝不会出现「生成一份重复建表的 SQL 被自动应用」的事故。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle/generated',
});
