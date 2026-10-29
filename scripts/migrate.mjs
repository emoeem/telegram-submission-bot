#!/usr/bin/env node
/**
 * 按顺序执行 migrations/*.sql，**逐条语句**跑，并且容忍"列已存在"。
 *
 * 为什么不用 `wrangler d1 execute --file=xxx.sql`：
 * 一个迁移文件里混着 CREATE TABLE IF NOT EXISTS 和裸 ALTER TABLE 时，只要有一条
 * ALTER 因为"列已存在"失败，D1 会把**整批**回滚——于是同一个文件后半段那张新表
 * 永远建不出来，而且报错点还停在 ALTER 上，看起来像是 ALTER 的问题。
 * 2026-10-16 那个文件就是这个形状（web_thread_messages 建不出来），2026-10-17 的
 * 补丁文件又没有任何 npm script 引用它，等于这张表在线上一直不存在。
 *
 * 用法：
 *   node scripts/migrate.mjs            # 本地（wrangler --local）
 *   node scripts/migrate.mjs --remote   # 线上
 * 环境变量：
 *   D1_DATABASE  覆盖库名（默认从 wrangler.toml 的 database_name 读）
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** 把 SQL 文本切成语句：去掉 `--` 行注释，按分号断句。 */
export function splitStatements(sql) {
  const withoutComments = String(sql)
    .split('\n')
    .map((line) => {
      const index = line.indexOf('--');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function resolveDatabaseName() {
  if (process.env.D1_DATABASE) return process.env.D1_DATABASE;
  try {
    const toml = await readFile(join(ROOT, 'wrangler.toml'), 'utf8');
    const match = toml.match(/^\s*database_name\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  } catch {
    /* 没有 wrangler.toml 就用默认名 */
  }
  return 'submission-bot-db';
}

async function runStatement(database, statement, { remote }) {
  const args = ['wrangler', 'd1', 'execute', database, remote ? '--remote' : '--local', '--command', statement, '-y'];
  try {
    await execFileAsync('npx', args, { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true };
  } catch (error) {
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    // 列已经存在 = 这条 ALTER 早就执行过了，继续跑后面的
    if (/duplicate column name/i.test(output)) return { ok: true, skipped: true };
    return { ok: false, output: output.trim() || String(error?.message ?? error) };
  }
}

async function main() {
  const remote = process.argv.includes('--remote');
  const database = await resolveDatabaseName();
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('没有找到迁移文件');
    return;
  }

  console.log(`==> 目标：${database}（${remote ? '线上' : '本地'}），${files.length} 个迁移文件`);
  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    const statements = splitStatements(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
    console.log(`\n--- ${file}（${statements.length} 条语句）`);
    for (const [index, statement] of statements.entries()) {
      const result = await runStatement(database, statement, { remote });
      if (!result.ok) {
        console.error(`  ✗ 第 ${index + 1} 条失败：${statement.split('\n')[0]}`);
        console.error(result.output);
        process.exitCode = 1;
        return;
      }
      if (result.skipped) {
        skipped += 1;
        console.log(`  ~ 第 ${index + 1} 条已存在，跳过`);
      } else {
        applied += 1;
        console.log(`  ✓ 第 ${index + 1} 条`);
      }
    }
  }

  console.log(`\n完成：执行 ${applied} 条，跳过 ${skipped} 条`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
