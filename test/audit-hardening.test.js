/** 审计加固（2026-10-30 二轮）：inbox 读限流、提交预检、show_if 方向、会话兜底清理。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import worker from '../src/index.js';
import { Store } from '../src/store.js';
import { createD1 } from './d1.js';
import { createHarness, SCHEMA } from './harness.js';

const BASE = 'https://bot.example';

function webHarness(envOverrides = {}) {
  return createHarness({
    CAPTCHA: '1',
    WEB_MIN_FILL_SECONDS: '0',
    WEB_RATE_LIMIT_COUNT: '0',
    ...envOverrides,
  });
}

async function getCaptcha(h) {
  const response = await worker.fetch(new Request(`${BASE}/api/submit/captcha`), h.env, h.ctx);
  assert.equal(response.status, 200);
  return response.json();
}

function solve(question) {
  const [a, operator, b] = String(question).split(' ');
  return operator === '+' ? String(Number(a) + Number(b)) : String(Number(a) * Number(b));
}

function defaultFields(overrides = {}) {
  return {
    'step:category': '图片分享',
    'step:title': '网页投稿标题',
    'step:body': '这是从网页提交的正文',
    'step:author': '匿名投稿',
    ...overrides,
  };
}

async function postSubmission(h, { fields = defaultFields(), headers = {} } = {}) {
  const captcha = await getCaptcha(h);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('token', captcha.token);
  form.append('captcha', solve(captcha.question));
  const response = await worker.fetch(
    new Request(`${BASE}/api/submit`, { method: 'POST', body: form, headers }),
    h.env,
    h.ctx,
  );
  await h.drain();
  return { status: response.status, body: await response.json() };
}

test('收件箱 GET 与写操作共用同一个按 IP 限流桶（读端点不再免费刷 submissions 表）', async () => {
  const h = webHarness({ WEB_RATE_LIMIT_COUNT: '1', WEB_RATE_LIMIT_WINDOW_SECONDS: '3600' });
  const url = `${BASE}/api/submit/inbox?t=${'a'.repeat(32)}`;
  const headers = { 'cf-connecting-ip': '203.0.113.9' };
  // 上限 = count*6 = 6 次：第 7 次必须 429，前 6 次 200。
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    statuses.push((await worker.fetch(new Request(url, { headers }), h.env, h.ctx)).status);
  }
  assert.deepEqual(
    statuses,
    [200, 200, 200, 200, 200, 200, 429],
    `inbox 读端点应与写操作共用 6×count 的限流桶：${statuses.join(',')}`,
  );
});

test('按 IP 限流的只读预检在解析表单之前就拒绝超限的提交', async () => {
  // 冻结时钟：分桶必须与请求里算出的窗口一致，否则预检读到的是另一个桶。
  const clock = () => 1_000_000_000;
  const h = webHarness({
    WEB_RATE_LIMIT_COUNT: '1',
    WEB_RATE_LIMIT_WINDOW_SECONDS: '3600',
    WEB_RATE_LIMIT_CLOCK: clock,
  });
  const headers = { 'cf-connecting-ip': '198.51.100.7' };
  const first = await postSubmission(h, { headers });
  assert.equal(first.status, 200, '第一次正常提交');

  // 同 IP 的下一次提交：预检在读 body 之前就该 429——哪怕请求体根本不合法
  //（没有 token；若走到了解析/校验，返回的会是 403/422 而不是 429）。
  const junk = new FormData();
  junk.append('step:body', 'x');
  const blocked = await worker.fetch(
    new Request(`${BASE}/api/submit`, { method: 'POST', body: junk, headers }),
    h.env,
    h.ctx,
  );
  assert.equal(blocked.status, 429, `超限 IP 的提交应在解析前被 429，实际 ${blocked.status}`);
});

test('show_if 指向后置步骤直接 ConfigError（渐进求值会静默丢字段）', () => {
  const forward = {
    default: {
      steps: [
        { id: 'a', type: 'text', prompt: 'A' },
        { id: 'b', type: 'choice', prompt: 'B', options: ['x', 'y'], show_if: { step: 'c', equals: 'x' } },
        { id: 'c', type: 'text', prompt: 'C' },
      ],
    },
  };
  assert.throws(() => loadConfig({ TEMPLATES_JSON: JSON.stringify(forward), BOT_TOKEN: 'x' }), /必须指向更早的步骤/);

  // 向前引用保持合法
  const backward = {
    default: {
      steps: [
        { id: 'a', type: 'text', prompt: 'A' },
        { id: 'b', type: 'choice', prompt: 'B', options: ['x', 'y'], show_if: { step: 'a', equals: 'x' } },
      ],
    },
  };
  assert.doesNotThrow(() => loadConfig({ TEMPLATES_JSON: JSON.stringify(backward), BOT_TOKEN: 'x' }));
});

test('pruneExpiredSessions：过期会话与附件被清，挂起草稿保留', async () => {
  const h = webHarness();
  const store = new Store(h.env.DB);
  const old = Math.floor(Date.now() / 1000) - 604800 - 10;
  const db = h.env.DB;

  const insertSession = db.prepare(
    'INSERT INTO sessions (user_id, template_id, step_id, data, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertMedia = db.prepare(
    "INSERT INTO session_media (user_id, step_id, ordinal, kind, payload, unique_id, created_at) VALUES (?, 'photos', 0, 'photo', ?, 'u1', ?)",
  );
  insertSession.bind(101, 'default', null, '{}', old).run();
  insertMedia.bind(101, JSON.stringify({ file_id: 'file-old' }), old).run();
  insertSession.bind(102, 'default', null, '{"__draft":true}', old).run();
  insertMedia.bind(102, JSON.stringify({ file_id: 'file-draft' }), old).run();

  await store.pruneExpiredSessions(604800);

  assert.equal(db.prepare('SELECT count(*) AS c FROM sessions WHERE user_id = 101').first().c, 0, '过期普通会话被清');
  assert.equal(
    db.prepare('SELECT count(*) AS c FROM session_media WHERE user_id = 101').first().c,
    0,
    '其附件一并被清',
  );
  assert.equal(db.prepare('SELECT count(*) AS c FROM sessions WHERE user_id = 102').first().c, 1, '挂起草稿保留');
  assert.equal(db.prepare('SELECT count(*) AS c FROM session_media WHERE user_id = 102').first().c, 1, '草稿附件保留');
});

test('countUnreadWebThread：缺表降级为 0，真实故障向上抛', async () => {
  // 裸库：连 submissions 都没有 → web_thread_messages 查询按缺表降级为 0
  const bare = new Store(createD1('CREATE TABLE placeholder (id INTEGER);'));
  assert.equal(await bare.countUnreadWebThread(1), 0, '缺表 → 0（降级）');

  // 真实故障：表存在但查询本身坏掉（往 prepare 里塞一个非法语句）
  const broken = new Store({
    prepare() {
      throw new Error('disk I/O error');
    },
  });
  await assert.rejects(() => broken.countUnreadWebThread(1), /disk I\/O error/, '真实故障原样抛出');
  assert.ok(SCHEMA.length > 0, 'schema 加载正常');
});
