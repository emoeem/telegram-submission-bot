/**
 * 后台审核接口（/api/admin/review/*）。
 *
 * 这组接口的存在理由是「同一件事有两个入口」：网页投稿原本只能在 Telegram
 * 审核群里点按钮，批量待审时在手机上一条条翻。现在后台也能审，但**审核逻辑
 * 只有一份**（bot.approveSubmission / bot.rejectSubmission），所以这里要钉住的
 * 最关键一条是：后台通过和群里通过走同一条发布路径、共用同一套租约。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { REVIEW_CHAT, TARGET_CHAT, createHarness } from './harness.js';

const BASE = 'https://bot.example';
const SECRET = 'review-secret-for-tests';

function reviewHarness(envOverrides = {}) {
  return createHarness({
    CAPTCHA: '1',
    WEB_MIN_FILL_SECONDS: '0',
    WEB_RATE_LIMIT_COUNT: '0',
    REVIEW_API_SECRET: SECRET,
    ADMIN_CHAT_ID: String(REVIEW_CHAT),
    ...envOverrides,
  });
}

function imageBlob(name = 'photo.jpg', bytes = 32) {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

function defaultFields(overrides = {}) {
  return {
    'step:category': '文字分享',
    'step:title': '一条来自网页的投稿',
    'step:body': '正文内容。',
    'step:author': '匿名投稿',
    ...overrides,
  };
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

/** 走一遍真实网页投稿，拿到一条待审的 web 投稿。 */
async function postWebSubmission(h, { fields = defaultFields(), files = [], headers = {} } = {}) {
  const captcha = await getCaptcha(h);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) form.append('file:photos', file, 'photo.jpg');
  form.append('token', captcha.token);
  form.append('captcha', solve(captcha.question));
  form.append('viewer', 'a'.repeat(32));
  form.append('email', 'author@example.com');

  const response = await worker.fetch(
    new Request(`${BASE}/api/submit`, { method: 'POST', body: form, headers }),
    h.env,
    h.ctx,
  );
  await h.drain();
  return { status: response.status, body: await response.json() };
}

async function call(h, path, { method = 'GET', secret = SECRET, body } = {}) {
  const headers = {};
  if (secret !== null) headers['x-review-secret'] = secret;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    h.env,
    h.ctx,
  );
  await h.drain();
  return { status: response.status, body: await response.json() };
}

test('后台审核接口：没配 REVIEW_API_SECRET 时整体关闭（fail-closed）', async () => {
  const h = reviewHarness({ REVIEW_API_SECRET: '' });
  const response = await call(h, '/api/admin/review/list');
  assert.equal(response.status, 503, '没配密钥必须是 503，不能是「没鉴权所以放行」');
  assert.match(response.body.error, /REVIEW_API_SECRET/);
});

test('后台审核接口：密钥不对 / 没带都是 401，且不透露差在哪', async () => {
  const h = reviewHarness();
  const wrong = await call(h, '/api/admin/review/list', { secret: 'nope' });
  assert.equal(wrong.status, 401);
  const missing = await call(h, '/api/admin/review/list', { secret: null });
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error, missing.body.error, '两种失败不该给出可区分的回应');
});

test('后台审核接口：列出网页投稿，只返回摘要不带全文', async () => {
  const h = reviewHarness();
  const posted = await postWebSubmission(h);
  assert.equal(posted.status, 200);
  assert.equal(posted.body.status, 'pending', '网页投稿默认要审');

  const list = await call(h, '/api/admin/review/list?status=pending');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items.length, 1);
  const item = list.body.items[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.email, 'author@example.com', '邮箱是网页投稿唯一的联系方式，审核时要看得见');
  assert.ok(item.preview.length <= 160, '列表只带摘要，正文留给 detail');
});

test('后台审核接口：详情给出可直接判断的正文与附件', async () => {
  const h = reviewHarness();
  await postWebSubmission(h, { files: [imageBlob()] });
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  const detail = await call(h, `/api/admin/review/detail?id=${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.submission.id, id);
  assert.match(detail.body.submission.text, /一条来自网页的投稿/);
  assert.equal(detail.body.submission.attachments.length, 1);
  assert.equal(detail.body.submission.attachments[0].kind, 'photo');
});

test('后台审核接口：detail 不认 Telegram 投稿，避免两条权限边界糊在一起', async () => {
  const h = reviewHarness();
  // 直接塞一条"看起来像 TG 投稿"的记录（没有 __source），后台接口不该认它
  await h.env.DB.prepare(
    `INSERT INTO submissions (user_id, username, full_name, template_id, data, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(999, 'someone', '某人', 'default', JSON.stringify({ 'step:title': 'TG 投稿' }), 'pending', 1)
    .run();

  const list = await call(h, '/api/admin/review/list');
  assert.equal(list.body.total, 0, '列表里不该出现 Telegram 投稿');
  const detail = await call(h, '/api/admin/review/detail?id=1');
  assert.equal(detail.status, 404);
});

test('后台审核接口：通过后真的发布了，且状态变 published', async () => {
  const h = reviewHarness();
  await postWebSubmission(h);
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  const approved = await call(h, '/api/admin/review/approve', { method: 'POST', body: { id } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.ok, true);

  const published = h.fake.messagesTo(TARGET_CHAT).filter((m) => m.text?.includes('一条来自网页的投稿'));
  assert.ok(published.length >= 1, '通过之后目标群必须收到这条投稿');

  const after = await call(h, `/api/admin/review/detail?id=${id}`);
  assert.equal(after.body.submission.status, 'published');
});

test('后台审核接口：重复通过返回 409，不会发第二遍', async () => {
  const h = reviewHarness();
  await postWebSubmission(h);
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  const first = await call(h, '/api/admin/review/approve', { method: 'POST', body: { id } });
  assert.equal(first.status, 200);
  const before = h.fake.messagesTo(TARGET_CHAT).length;

  const second = await call(h, '/api/admin/review/approve', { method: 'POST', body: { id } });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'already_published');
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, before, '第二次点击不能重复发');
});

test('后台审核接口：驳回会写下理由并把状态改掉', async () => {
  const h = reviewHarness();
  await postWebSubmission(h);
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  const rejected = await call(h, '/api/admin/review/reject', {
    method: 'POST',
    body: { id, reason: '内容不符合栏目' },
  });
  assert.equal(rejected.status, 200);

  const after = await call(h, `/api/admin/review/detail?id=${id}`);
  assert.equal(after.body.submission.status, 'rejected');
  assert.equal(
    h.fake.messagesTo(TARGET_CHAT).filter((m) => m.text?.includes('一条来自网页的投稿')).length,
    0,
    '驳回不该发布',
  );
});

test('后台审核接口：已发布的投稿不能再驳回（否则库里说驳回、群里还挂着）', async () => {
  const h = reviewHarness();
  await postWebSubmission(h);
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  // 先通过，让它真的发到目标群
  const approved = await call(h, '/api/admin/review/approve', { method: 'POST', body: { id } });
  assert.equal(approved.status, 200);
  const publishedCount = h.fake.messagesTo(TARGET_CHAT).length;
  assert.ok(publishedCount >= 1, '通过后目标群必须有消息，否则这条用例的前提不成立');

  // 再点驳回：必须被挡住，而不是把状态改成 rejected
  // 这是真机上验出来的：approve 对已发布返回 409，reject 却返回 ok:true，
  // 结果库里 status=rejected 而频道里那条消息仍在，作者还会收到一条"已驳回"。
  const rejected = await call(h, '/api/admin/review/reject', {
    method: 'POST',
    body: { id, reason: '想下架' },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'already_published');

  const after = await call(h, `/api/admin/review/detail?id=${id}`);
  assert.equal(after.body.submission.status, 'published', '状态必须仍是 published，不能出现「库里已驳回、群里还在」');
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, publishedCount, '既不能重复发，也不能顺手撤回首条');
});

test('后台审核接口：回复投稿者会进站内线程', async () => {
  const h = reviewHarness();
  await postWebSubmission(h);
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  const replied = await call(h, '/api/admin/review/reply', {
    method: 'POST',
    body: { id, text: '照片很清晰，能补一张竖版的吗？' },
  });
  assert.equal(replied.status, 200);

  // 作者侧收件箱应该能读到这条留言
  const inbox = await worker.fetch(new Request(`${BASE}/api/submit/inbox?t=${'a'.repeat(32)}`), h.env, h.ctx);
  const inboxBody = await inbox.json();
  const thread = inboxBody.items?.[0]?.thread ?? [];
  assert.ok(
    thread.some((entry) => String(entry.text ?? '').includes('能补一张竖版的吗')),
    '管理员留言要出现在作者的收件箱里',
  );
});

test('后台审核接口：参数不合法时给出 400/404/422 而不是 500', async () => {
  const h = reviewHarness();
  assert.equal((await call(h, '/api/admin/review/detail')).status, 400, '缺 id');
  assert.equal((await call(h, '/api/admin/review/detail?id=abc')).status, 400, 'id 非数字');
  assert.equal((await call(h, '/api/admin/review/detail?id=99999')).status, 404, '不存在的 id');
  assert.equal((await call(h, '/api/admin/review/approve', { method: 'POST', body: { id: 99999 } })).status, 404);
  assert.equal(
    (await call(h, '/api/admin/review/reject', { method: 'POST', body: { id: 1, reason: 'x'.repeat(301) } })).status,
    422,
  );
  assert.equal((await call(h, '/api/admin/review/nope')).status, 404, '未知操作不能掉进 HTML 兜底');
});

/* ---------------------------------------------------------------------------
 * 附件预览（/api/admin/review/media）
 *
 * 后台审核停在「只能看见 photo、photo、photo」等于没有附件信息 —— 审核人没法
 * 判断图里是什么，还是得回群里翻。这条接口把字节取回来，但有三件事必须钉住：
 * ① 和其它审核接口共用同一把密钥（不能为了看图另开一个无鉴权的口子）
 * ② 只认网页投稿（Telegram 投稿有它自己的审核流）
 * ③ document 强制下载、photo 内联 —— 上传通道是公开的，内联一个 SVG 就是
 *    同源 stored XSS，而这条接口挂的正是后台域名
 * ------------------------------------------------------------------------- */

/** media 端点回二进制，不能复用 call()（它会 json() 一次响应体）。 */
async function fetchMedia(h, query, { secret = SECRET } = {}) {
  const headers = {};
  if (secret !== null) headers['x-review-secret'] = secret;
  const response = await worker.fetch(new Request(`${BASE}/api/admin/review/media${query}`, { headers }), h.env, h.ctx);
  await h.drain();
  return response;
}

test('后台审核接口：media 与其它接口共用同一把密钥，没带就是 401', async () => {
  const h = reviewHarness();
  await postWebSubmission(h, { files: [imageBlob()] });
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  const denied = await fetchMedia(h, `?submission=${id}&index=0`, { secret: null });
  assert.equal(denied.status, 401, '缺密钥必须 401：能取附件字节的口子不能是裸的');

  const wrong = await fetchMedia(h, `?submission=${id}&index=0`, { secret: 'nope' });
  assert.equal(wrong.status, 401);
});

test('后台审核接口：media 把图片字节取回来，photo 内联而不是强制下载', async () => {
  const h = reviewHarness();
  await postWebSubmission(h, { files: [imageBlob('a.jpg', 64)] });
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  const response = await fetchMedia(h, `?submission=${id}&index=0`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('content-disposition'), null, 'photo 要能直接内联显示，否则前端只能给一个下载链接');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, 64, '取回的字节数要和上传的一致');
});

test('后台审核接口：document 强制下载，避免同源内联渲染成 XSS', async () => {
  const h = reviewHarness();
  /* 传一个 .html：如果服务端信任上传声明并内联渲染，后台域名下就是一个
   * stored XSS。注意 kind 由客户端的 `file.type` 决定（web.js 的 collectFiles），
   * 所以这里必须给一个非 image/video 的 type，才能真正走 document 通道。 */
  const html = new File([new TextEncoder().encode('<script>alert(1)</script>')], 'x.html', {
    type: 'text/html',
  });
  await postWebSubmission(h, { files: [html] });
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;
  const detail = await call(h, `/api/admin/review/detail?id=${id}`);
  assert.equal(detail.body.submission.attachments[0].kind, 'document', 'html 走文件通道，不是 photo');

  const response = await fetchMedia(h, `?submission=${id}&index=0`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream', '认不出的扩展名不能当图片');
  assert.match(
    String(response.headers.get('content-disposition')),
    /attachment/,
    'document 必须走下载，不能被浏览器内联执行',
  );
});

test('后台审核接口：media 的序号越界 / 非网页投稿都是 404，不会有半读', async () => {
  const h = reviewHarness();
  await postWebSubmission(h, { files: [imageBlob()] });
  const list = await call(h, '/api/admin/review/list');
  const id = list.body.items[0].id;

  assert.equal((await fetchMedia(h, `?submission=${id}&index=5`)).status, 404, '越界');
  assert.equal((await fetchMedia(h, `?submission=${id}&index=-1`)).status, 400, '负数');
  assert.equal((await fetchMedia(h, `?submission=${id}&index=abc`)).status, 400, '非数字');
  assert.equal((await fetchMedia(h, '?index=0')).status, 400, '缺投稿编号');
  assert.equal((await fetchMedia(h, '?submission=99999&index=0')).status, 404, '不存在的投稿');
});
