/**
 * 网页投稿的加固回归：令牌一次性、并发限流、评论归属、缺表降级、中继无 IP。
 *
 * 这些用例对应的都是"测试全绿但功能是坏的"那一类问题：
 * - 令牌可重放（签名/有效期/答案都对，但没有一次性登记）；
 * - 限流先读后写（并发请求全都读到旧计数，限 3 次能穿到 10 次）；
 * - 回复评论只按 (chat, message_id) 取，没校验评论属于这篇投稿；
 * - getWebThread 注释写着"缺表不要 500"，代码里没有 try/catch；
 * - 中继验过身份却没带 IP 头时回落到中继自己的出口 IP，全站访客共用一个桶。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { TARGET_CHAT, createHarness, groupReply } from './harness.js';

const BASE = 'https://bot.example';

function webHarness(envOverrides = {}) {
  return createHarness({ CAPTCHA: '1', WEB_MIN_FILL_SECONDS: '0', WEB_RATE_LIMIT_COUNT: '0', ...envOverrides });
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

function buildForm({ token, answer, viewer, body = '正文', headers = {} }) {
  const form = new FormData();
  form.append('step:category', '图片分享');
  form.append('step:title', '加固回归标题');
  form.append('step:body', body);
  form.append('step:author', '匿名投稿');
  if (viewer) form.append('viewer', viewer);
  form.append('token', token);
  form.append('captcha', answer);
  return new Request(`${BASE}/api/submit`, { method: 'POST', body: form, headers });
}

async function submit(h, { viewer, body = '正文', headers = { 'cf-connecting-ip': '1.2.3.4' } } = {}) {
  const captcha = await getCaptcha(h);
  const response = await worker.fetch(
    buildForm({ token: captcha.token, answer: solve(captcha.question), viewer, body, headers }),
    h.env,
    h.ctx,
  );
  await h.drain();
  return { status: response.status, body: await response.json(), captcha };
}

test('表单令牌一次性：同一个 token 第二次提交被拒（409），不是再收一份投稿', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const captcha = await getCaptcha(h);
  const answer = solve(captcha.question);

  const first = await worker.fetch(buildForm({ token: captcha.token, answer }), h.env, h.ctx);
  await h.drain();
  assert.equal(first.status, 200);

  const replay = await worker.fetch(buildForm({ token: captcha.token, answer }), h.env, h.ctx);
  await h.drain();
  assert.equal(replay.status, 409, '重放同一个令牌必须被拒');
  const payload = await replay.json();
  assert.equal(payload.ok, false);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1, '只有第一份落库');
});

test('表单校验失败不烧掉令牌：改完再提交还能过（不能把内容丢掉）', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const captcha = await getCaptcha(h);
  const answer = solve(captcha.question);

  // 少填正文 → 422
  const form = new FormData();
  form.append('step:category', '图片分享');
  form.append('step:title', '标题');
  form.append('step:author', '匿名投稿');
  form.append('token', captcha.token);
  form.append('captcha', answer);
  const invalid = await worker.fetch(
    new Request(`${BASE}/api/submit`, { method: 'POST', body: form, headers: { 'cf-connecting-ip': '1.2.3.4' } }),
    h.env,
    h.ctx,
  );
  assert.equal(invalid.status, 422);

  // 同一个令牌补上正文再提交 → 必须放行
  const retry = await worker.fetch(
    buildForm({ token: captcha.token, answer, headers: { 'cf-connecting-ip': '1.2.3.4' } }),
    h.env,
    h.ctx,
  );
  await h.drain();
  assert.equal(retry.status, 200, '校验失败不该消耗令牌');
});

test('表单令牌表缺失时退化放行（不因为缺表把投稿全拦掉）', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  h.env.DB.raw.exec('DROP TABLE web_form_nonces');
  const result = await submit(h);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test('并发提交不会穿透按 IP 限流：限 1 次时 8 个并发只放行 1 个', async () => {
  const clock = () => 1_000_000_000;
  const h = webHarness({
    WEB_REQUIRE_REVIEW: '0',
    WEB_RATE_LIMIT_COUNT: '1',
    WEB_RATE_LIMIT_WINDOW_SECONDS: '3600',
    WEB_RATE_LIMIT_CLOCK: clock,
  });

  // 先把令牌都拿到（每份各一个，避免被"令牌一次性"先拦掉）
  const captchas = await Promise.all(Array.from({ length: 8 }, () => getCaptcha(h)));

  const results = await Promise.all(
    captchas.map((captcha) =>
      worker.fetch(
        buildForm({
          token: captcha.token,
          answer: solve(captcha.question),
          headers: { 'cf-connecting-ip': '1.2.3.4' },
        }),
        h.env,
        h.ctx,
      ),
    ),
  );
  await h.drain();

  const statuses = results.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1, `只该放行 1 次，实际：${statuses.join(',')}`);
  assert.equal(statuses.filter((status) => status === 429).length, 7, '其余全部 429');
});

test('回复评论必须属于这篇投稿：拿自己的投稿 id 配别人的评论被拒', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const viewerA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const viewerB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const a = await submit(h, { viewer: viewerA, body: 'A 的投稿' });
  const b = await submit(h, { viewer: viewerB, body: 'B 的投稿' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const bRow = h.env.DB.raw.prepare('SELECT * FROM submissions WHERE id = ?').get(b.body.id);
  const bPost = h.fake.messagesTo(TARGET_CHAT).find((m) => m.message_id === bRow.publish_message_id);
  assert.ok(bPost, 'B 的投稿应该已经发到目标频道');
  const commentUpdate = groupReply(h, bPost, '这条评论挂在 B 的投稿下');
  await h.dispatch(commentUpdate);
  const commentId = commentUpdate.message.message_id;

  const forged = await worker.fetch(
    new Request(`${BASE}/api/submit/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewer: viewerA, submissionId: a.body.id, commentMessageId: commentId, text: '我是作者' }),
    }),
    h.env,
    h.ctx,
  );
  await h.drain();

  assert.equal(forged.status, 400, '不属于这篇投稿的评论必须拒绝');
  assert.equal(
    h.fake.messagesTo(TARGET_CHAT).filter((m) => m.text?.includes('作者回复：')).length,
    0,
    '不能在别人的评论下面挂"作者回复"',
  );
});

test('web_thread_messages 缺表时收件箱仍然能打开（不 500）', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const viewer = 'cccccccccccccccccccccccccccccccc';
  const created = await submit(h, { viewer });
  assert.equal(created.status, 200);

  h.env.DB.raw.exec('DROP TABLE web_thread_messages');

  const inbox = await worker.fetch(new Request(`${BASE}/api/submit/inbox?t=${viewer}`), h.env, h.ctx);
  await h.drain();
  assert.equal(inbox.status, 200, '缺表要退化成"没有留言"，不是把收件箱打成 500');
  const payload = await inbox.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.items.length, 1);
  assert.deepEqual(payload.items[0].thread ?? [], []);
});

test('中继验过身份但没带 IP 头时，不会把所有访客算成同一个人', async () => {
  const clock = () => 1_000_000_000;
  const h = webHarness({
    WEB_REQUIRE_REVIEW: '0',
    WEB_RATE_LIMIT_COUNT: '1',
    WEB_RATE_LIMIT_WINDOW_SECONDS: '3600',
    WEB_RATE_LIMIT_CLOCK: clock,
    RELAY_SECRET: 'relay-secret-value',
  });

  // 只带中继令牌，不带任何转发 IP 头：以前会回落到 cf-connecting-ip（中继自己的出口），
  // 于是第 2 个访客直接被 429。现在解析不出真实 IP → 跳过按 IP 限流。
  const headers = { 'x-relay-token': 'relay-secret-value', 'cf-connecting-ip': '34.96.0.9' };
  const first = await submit(h, { headers });
  const second = await submit(h, { headers });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, '两个不同访客不该被算进同一个桶');
});

test('中继转发头取最后一跳：客户端自带的伪造 IP 不能换桶', async () => {
  const clock = () => 1_000_000_000;
  const h = webHarness({
    WEB_REQUIRE_REVIEW: '0',
    WEB_RATE_LIMIT_COUNT: '1',
    WEB_RATE_LIMIT_WINDOW_SECONDS: '3600',
    WEB_RATE_LIMIT_CLOCK: clock,
    RELAY_SECRET: 'relay-secret-value',
  });

  // 中继是 append 语义：真实访客 IP 在最后，前面那段是客户端自己塞的
  const headers = { 'x-relay-token': 'relay-secret-value', 'x-forwarded-for': '9.9.9.9, 203.0.113.7' };
  const first = await submit(h, { headers });
  assert.equal(first.status, 200);

  const spoofed = await submit(h, {
    headers: { 'x-relay-token': 'relay-secret-value', 'x-forwarded-for': '8.8.8.8, 203.0.113.7' },
  });
  assert.equal(spoofed.status, 429, '换一个伪造的首跳不能换到新的限流桶');
});
