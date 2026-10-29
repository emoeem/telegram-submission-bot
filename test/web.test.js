/** 网页投稿（/submit + /api/submit）：页面、验证、限流、审核、发布全链路。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import {
  ADMIN_ID,
  REVIEW_CHAT,
  TARGET_CHAT,
  USER_ID,
  clickButton,
  createHarness,
  groupCommand,
  groupReply,
  privateMessage,
} from './harness.js';
import { findButton } from './fake-telegram.js';

const BASE = 'https://bot.example';

function webHarness(envOverrides = {}, fakeOptions = {}) {
  return createHarness(
    {
      CAPTCHA: '1',
      WEB_MIN_FILL_SECONDS: '0',
      WEB_RATE_LIMIT_COUNT: '0',
      ...envOverrides,
    },
    fakeOptions,
  );
}

async function getCaptcha(h) {
  const response = await worker.fetch(new Request(`${BASE}/api/submit/captcha`), h.env, h.ctx);
  assert.equal(response.status, 200);
  return response.json();
}

/** 解开验证题的答案（题目是 "3 + 5" / "3 × 5"）。 */
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

async function postSubmission(h, { fields = defaultFields(), files = [], form: extraForm = [], headers = {} } = {}) {
  const captcha = await getCaptcha(h);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const item of extraForm) form.append(item.key, item.value);
  for (const file of files) form.append(file.field ?? 'file:photos', file.blob, file.name ?? 'photo.jpg');
  form.append('token', captcha.token);
  form.append('captcha', solve(captcha.question));

  const response = await worker.fetch(
    new Request(`${BASE}/api/submit`, { method: 'POST', body: form, headers }),
    h.env,
    h.ctx,
  );
  await h.drain();
  return { status: response.status, body: await response.json(), captcha };
}

function imageBlob(name = 'photo.jpg', bytes = 32) {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

test('网页投稿页面：不依赖任何外部资源，带完整表单和验证题', async () => {
  const h = webHarness();
  const response = await worker.fetch(new Request(`${BASE}/submit`), h.env, h.ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();

  assert.match(html, /<form id="submit-form"/);
  assert.match(html, /name="step:body"/);
  assert.match(html, /name="step:category"/);
  assert.match(html, /name="file:photos"/);
  assert.match(html, /name="nickname"/);
  assert.match(html, /\/api\/submit\/captcha/, '页面自己去取验证题');
  assert.ok(!/src="https?:\/\//.test(html), '不能引用外部脚本（国内打不开）');
  assert.ok(!/href="https?:\/\/[^"]*\.css/.test(html), '不能引用外部样式');

  const disabled = webHarness({ WEB_ENABLED: '0' });
  const notFound = await worker.fetch(new Request(`${BASE}/submit`), disabled.env, disabled.ctx);
  assert.equal(notFound.status, 404, 'WEB_ENABLED=0 时页面直接 404');
});

test('网页投稿：验证题 / 蜜罐 / 必填项都会被拦下，且不留下投稿记录', async () => {
  const h = webHarness();
  const captcha = await getCaptcha(h);
  assert.ok(captcha.token);
  assert.match(captcha.question, /^\d+ [+×] \d+$/);

  // 1) 算错了
  const wrong = await postWrong(h, captcha.token, '999');
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error, /验证答案不对/);

  // 2) 蜜罐字段被填 → 丢弃
  const honeypot = await postSubmission(h, { form: [{ key: 'website', value: 'http://spam.example' }] });
  assert.equal(honeypot.status, 400);

  // 3) 必填项缺失
  const missing = await postSubmission(h, { fields: defaultFields({ 'step:body': '' }) });
  assert.equal(missing.status, 422);
  assert.match(missing.body.errors.body, /请填写/);

  // 4) 填太快的提交会被拦（默认 3 秒）
  const fast = webHarness({ WEB_MIN_FILL_SECONDS: '3' });
  const fastCaptcha = await getCaptcha(fast);
  const tooFast = await postWithToken(fast, fastCaptcha, solve(fastCaptcha.question));
  assert.equal(tooFast.status, 403);
  assert.match(tooFast.body.error, /太快/);

  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 0, '被拦下的请求不能建投稿');
});

async function postWrong(h, token, answer) {
  const form = new FormData();
  for (const [key, value] of Object.entries(defaultFields())) form.append(key, value);
  form.append('token', token);
  form.append('captcha', answer);
  const response = await worker.fetch(new Request(`${BASE}/api/submit`, { method: 'POST', body: form }), h.env, h.ctx);
  return { status: response.status, body: await response.json() };
}

async function postWithToken(h, captcha, answer) {
  const form = new FormData();
  for (const [key, value] of Object.entries(defaultFields())) form.append(key, value);
  form.append('token', captcha.token);
  form.append('captcha', answer);
  const response = await worker.fetch(new Request(`${BASE}/api/submit`, { method: 'POST', body: form }), h.env, h.ctx);
  return { status: response.status, body: await response.json() };
}

test('网页投稿默认要审核：媒体上传换 file_id，审核卡片发到审核群，通过后才发布', async () => {
  const h = webHarness({ ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const photo = imageBlob('cats.jpg');

  const result = await postSubmission(h, { files: [{ blob: photo, name: 'cats.jpg' }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'pending', '默认必须审核，不能直接发布');
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0, '审核通过前目标群一条消息都不能有');

  // 媒体先上传到审核群换成 file_id
  const upload = h.fake.callsOf('sendPhoto').find((call) => Number(call.chat_id) === REVIEW_CHAT);
  assert.ok(upload, '上传应该发生在审核会话里');

  const row = h.env.DB.raw.prepare('SELECT * FROM submissions WHERE id = ?').get(result.body.id);
  const data = JSON.parse(row.data);
  assert.equal(data.__source, 'web');
  assert.match(data.photos[0].fileId, /^uploaded-photo-/, 'data 里存的是 Telegram file_id');
  assert.equal(row.user_id, 0, '网页投稿没有 Telegram 账号');

  // 审核卡片 + 通过按钮在审核群里
  const card = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.ok(card, '审核群要收到卡片');
  assert.match(card.text, /网页投稿/);
  assert.ok((card.keyboard.inline_keyboard ?? []).flat().some((b) => b.text.includes('通过')));

  const beforePublish = h.fake.callsOf('sendPhoto').filter((call) => Number(call.chat_id) === TARGET_CHAT).length;
  await h.dispatch(clickButton(h, findButton(card, '通过'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length > 0, true, '通过后应该发布到目标群');

  const published = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.ok(published, '正文应该发到目标群');
  // 发布用的是同一张图（file_id 复用，不再重新上传）
  const publishPhoto = h.fake.callsOf('sendPhoto').at(-1);
  assert.match(String(publishPhoto.photo), /^uploaded-photo-/);
  assert.equal(
    h.fake.callsOf('sendPhoto').filter((c) => Number(c.chat_id) === TARGET_CHAT).length > beforePublish,
    true,
  );

  // 网页投稿没有 Telegram 账号：通过/拒绝都不该往 chat_id 0 发消息
  assert.equal(h.fake.messagesTo(0).length, 0);

  const after = h.env.DB.raw.prepare('SELECT status FROM submissions WHERE id = ?').get(result.body.id);
  assert.equal(after.status, 'published');
});

test('网页投稿：没配审核群时，审核卡片私聊发给管理员', async () => {
  const h = webHarness();
  const result = await postSubmission(h);
  assert.equal(result.body.status, 'pending');

  const dm = h.fake.messagesTo(ADMIN_ID).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.ok(dm, '管理员私聊里要收到审核卡片');
  assert.match(dm.text, /网页投稿/);

  await h.dispatch(clickButton(h, findButton(dm, '通过'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  const published = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.ok(published, '通过后照样能发布到目标群');
});

test('网页投稿：关掉强制审核就直接发布，并给出链接', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const result = await postSubmission(h);
  assert.equal(result.body.status, 'published');
  assert.ok(result.body.link, '直发时应该返回投稿链接');

  const published = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.ok(published);
  assert.equal(
    h.env.DB.raw.prepare('SELECT status FROM submissions WHERE id = ?').get(result.body.id).status,
    'published',
  );
});

test('网页投稿：发布到绑定的话题里（论坛群）', async () => {
  const h = webHarness({ TARGET_CHAT_ID: '', WEB_REQUIRE_REVIEW: '0' });
  const topicId = 4242;
  await h.dispatch(groupCommand(h, '/bind', { chatId: TARGET_CHAT, threadId: topicId }));

  const result = await postSubmission(h);
  assert.equal(result.body.status, 'published');
  const published = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.equal(published.threadId, topicId, '网页投稿也要发进绑定的话题');
});

test('网页投稿：按 IP 限流，中继头只有在带正确 relay token 时才被采信', async () => {
  // 冻结时钟：真实时间会让这个用例在整点边界上从 429 翻成 200 —— 分桶换了窗口，
  // 前面攒的计数清零。那是每小时随机炸一次的假失败，看起来却像限流坏了。
  const clock = () => 1_000_000_000;
  const h = webHarness({
    WEB_RATE_LIMIT_COUNT: '1',
    WEB_RATE_LIMIT_WINDOW_SECONDS: '3600',
    WEB_RATE_LIMIT_CLOCK: clock,
  });

  // 第一次成功
  const first = await postSubmission(h, { headers: { 'cf-connecting-ip': '1.2.3.4' } });
  assert.equal(first.status, 200);

  // 同一个 IP 再来一次 → 429；伪造的 x-forwarded-for 不生效（没带中继密钥）
  const spoofed = await postSubmission(h, {
    headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' },
  });
  assert.equal(spoofed.status, 429, '伪造转发头不能换到新的限流桶');

  // 换个 IP 就还能投
  const other = await postSubmission(h, { headers: { 'cf-connecting-ip': '5.6.7.8' } });
  assert.equal(other.status, 200);

  // 配置了中继密钥后：带正确 token 的请求按转发头里的真实访客 IP 分桶
  const relayed = webHarness({
    WEB_RATE_LIMIT_COUNT: '1',
    WEB_RATE_LIMIT_WINDOW_SECONDS: '3600',
    RELAY_SECRET: 'relay-secret-value',
    WEB_RATE_LIMIT_CLOCK: clock,
  });
  const relayHeaders = { 'x-relay-token': 'relay-secret-value', 'x-vercel-proxied-for': '203.0.113.7' };
  const a = await postSubmission(relayed, { headers: relayHeaders });
  assert.equal(a.status, 200);
  const b = await postSubmission(relayed, { headers: relayHeaders });
  assert.equal(b.status, 429, '同一个真实访客 IP 会共用同一个桶');
  const c = await postSubmission(relayed, {
    headers: { 'x-relay-token': 'relay-secret-value', 'x-vercel-proxied-for': '203.0.113.8' },
  });
  assert.equal(c.status, 200, '不同访客 IP 各用各的桶');

  // token 不对 → 退回 cf-connecting-ip，伪造头无效
  const d = await postSubmission(relayed, {
    headers: { 'x-relay-token': 'wrong', 'x-vercel-proxied-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.7' },
  });
  assert.equal(d.status, 429);
});

test('网页投稿：敏感词在审核模式下交给管理员，直发模式下直接拒绝', async () => {
  const review = webHarness({ BANNED_WORDS: '违禁词', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const ok = await postSubmission(review, { fields: defaultFields({ 'step:body': '正文里有违禁词' }) });
  assert.equal(ok.body.status, 'pending', '审核模式下不拦，交给管理员判断');
  const card = review.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('违禁词'));
  assert.match(card.text, /敏感词/, '审核卡片要标出命中的敏感词');

  const direct = webHarness({ BANNED_WORDS: '违禁词', WEB_REQUIRE_REVIEW: '0' });
  const blocked = await postSubmission(direct, { fields: defaultFields({ 'step:body': '正文里有违禁词' }) });
  assert.equal(blocked.status, 500);
  assert.match(blocked.body.error, /提交失败/);
});

test('网页投稿：「显示我的昵称」必须填昵称，昵称会写进投稿记录', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const missing = await postSubmission(h, { fields: defaultFields({ 'step:author': '显示我的昵称' }) });
  assert.equal(missing.status, 422);
  assert.match(missing.body.errors.nickname, /昵称/);

  const ok = await postSubmission(h, {
    fields: defaultFields({ 'step:author': '显示我的昵称' }),
    form: [{ key: 'nickname', value: '网页小明' }],
  });
  assert.equal(ok.body.ok, true);
  const row = h.env.DB.raw.prepare('SELECT full_name FROM submissions WHERE id = ?').get(ok.body.id);
  assert.equal(row.full_name, '网页小明');
  const published = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.match(published.text, /网页小明/, '发布的文案里用网页填的昵称署名');
});

test('网页投稿：文件个数/大小超限会被拦下', async () => {
  const h = webHarness({ WEB_MAX_FILES: '1', WEB_MAX_FILE_MB: '1' });
  const tooMany = await postSubmission(h, {
    files: [
      { blob: imageBlob('a.jpg'), name: 'a.jpg' },
      { blob: imageBlob('b.jpg'), name: 'b.jpg' },
    ],
  });
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.body.errors.photos, /最多 1 个/);

  const big = await postSubmission(h, { files: [{ blob: imageBlob('big.jpg', 2 * 1024 * 1024), name: 'big.jpg' }] });
  assert.equal(big.status, 422);
  assert.match(big.body.errors.photos, /不能超过/);
});

test('网页投稿：/pending 与 /approve_all 能处理网页投稿', async () => {
  const h = webHarness({ ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const result = await postSubmission(h);
  assert.equal(result.body.status, 'pending');

  await h.dispatch(privateMessageLike(h, '/pending', ADMIN_ID));
  const list = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(list.text, /待审/);

  await h.dispatch(privateMessageLike(h, '/approve_all', ADMIN_ID));
  const published = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.ok(published, '/approve_all 也要能通过网页投稿');
});

function privateMessageLike(h, text, userId) {
  return {
    message: {
      message_id: h.nextIncoming(),
      from: { id: userId, is_bot: false, first_name: '管理员', username: 'admin' },
      chat: { id: userId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

test('网页投稿：限流表缺失（老库还没迁移）时降级为不限流，而不是把投稿打挂', async () => {
  const h = webHarness({ WEB_RATE_LIMIT_COUNT: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  h.env.DB.raw.exec('DROP TABLE web_rate_limits');

  const result = await postSubmission(h);
  assert.equal(result.status, 200, '缺表时也不能 500');
  assert.equal(result.body.ok, true);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1, '投稿照样建起来');
});

test('机器人本体：配了 WEB_PUBLIC_URL 后，欢迎语与菜单都给出网页投稿入口', async () => {
  const url = 'https://example.test/submit';
  const h = webHarness({ WEB_PUBLIC_URL: url });
  await h.dispatch(privateMessage(h, '/start'));

  const welcome = h.fake.lastMessageTo(USER_ID);
  assert.match(welcome.text, /网页投稿/, '欢迎语要提到网页投稿');
  assert.ok(welcome.text.includes(url), '欢迎语里要给出可复制/转发的地址');
  const buttons = (welcome.keyboard?.inline_keyboard ?? []).flat();
  assert.ok(
    buttons.some((button) => button.url === url),
    '菜单最上面要有网页投稿按钮',
  );
  assert.ok(
    buttons.some((button) => button.callback_data === 'w:start'),
    '原来的 Telegram 向导入口仍然保留',
  );

  // 没配地址时：菜单和欢迎语里都不该出现网页入口（行为与以前一致）
  const plain = webHarness();
  await plain.dispatch(privateMessage(plain, '/start'));
  const plainWelcome = plain.fake.lastMessageTo(USER_ID);
  assert.ok(!plainWelcome.text.includes('/submit'), '没配就不该提网页投稿');
  assert.ok(
    !(plainWelcome.keyboard?.inline_keyboard ?? [])
      .flat()
      .some((button) => String(button.url ?? '').includes('/submit')),
    '没配就不该有网页投稿按钮',
  );
});

test('收件箱：只有自己的浏览器身份能看，令牌不对返回空', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const viewer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const form = [
    { key: 'viewer', value: viewer },
    { key: 'email', value: 'author@example.test' },
  ];
  const created = await postSubmission(h, { form });
  assert.equal(created.body.ok, true);

  const mine = await worker.fetch(new Request(`${BASE}/api/submit/inbox?t=${viewer}`), h.env, h.ctx);
  const mineBody = await mine.json();
  assert.equal(mineBody.items.length, 1);
  assert.equal(mineBody.items[0].id, created.body.id, '能看到自己那条');

  const other = await worker.fetch(
    new Request(`${BASE}/api/submit/inbox?t=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`),
    h.env,
    h.ctx,
  );
  assert.equal((await other.json()).items.length, 0, '别人的令牌看不到');

  const none = await worker.fetch(new Request(`${BASE}/api/submit/inbox`), h.env, h.ctx);
  assert.equal(none.status, 400);
});

test('收件箱：新评论会记进收件箱，并给留了邮箱的投稿者发通知邮件', async () => {
  const h = webHarness({
    WEB_REQUIRE_REVIEW: '0',
    RESEND_API_KEY: 'test-key',
    MAIL_FROM: '投稿机器人 <noreply@example.com>',
  });
  const viewer = 'cccccccccccccccccccccccccccccccc';
  const mails = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      mails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'test' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const created = await postSubmission(h, {
      form: [
        { key: 'viewer', value: viewer },
        { key: 'email', value: 'author@example.test' },
      ],
    });
    assert.equal(created.body.status, 'published');
    const row = h.env.DB.raw.prepare('SELECT * FROM submissions WHERE id = ?').get(created.body.id);
    const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.message_id === row.publish_message_id);
    assert.ok(post, '投稿要真的发到群里');

    // 群里有人评论 → 网页投稿者收邮件 + 收件箱里可见
    await h.dispatch(
      groupReply(h, post, '这条写得不错'), // 复用 harness 的群内回复助手
    );
    assert.equal(
      h.fake.callsOf('sendMessage').filter((c) => Number(c.chat_id) === 0).length,
      0,
      '不该往 chat_id 0 发消息',
    );
    assert.ok(mails.length >= 1, '应该发了一封邮件');
    assert.match(mails[0].to[0], /author@example\.test/);
    assert.match(mails[0].subject, /评论/);

    const inbox = await worker.fetch(new Request(`${BASE}/api/submit/inbox?t=${viewer}`), h.env, h.ctx);
    const item = (await inbox.json()).items[0];
    assert.equal(item.comments.length, 1);
    assert.equal(item.comments[0].text, '这条写得不错');
    assert.equal(item.unreadComments > 0, true, '第一次打开时未读计数要大于 0');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('收件箱：回复评论会以「作者回复」公开出现在评论区', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const viewer = 'dddddddddddddddddddddddddddddddd';
  const created = await postSubmission(h, { form: [{ key: 'viewer', value: viewer }] });
  const row = h.env.DB.raw.prepare('SELECT * FROM submissions WHERE id = ?').get(created.body.id);
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.message_id === row.publish_message_id);
  const commentUpdate = groupReply(h, post, '求问出处');
  await h.dispatch(commentUpdate);

  const commentId = commentUpdate.message.message_id;
  const reply = await worker.fetch(
    new Request(`${BASE}/api/submit/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewer, submissionId: created.body.id, commentMessageId: commentId, text: '出自某本书' }),
    }),
    h.env,
    h.ctx,
  );
  await h.drain();
  assert.equal((await reply.json()).ok, true);

  const replyMessage = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('作者回复：'));
  assert.ok(replyMessage, '作者回复要出现在评论区');
  assert.equal(replyMessage.reply_to, commentId, '挂在被回复的那条评论下面');

  // 只有自己的令牌能回；别人的令牌一律 404
  const foreign = await worker.fetch(
    new Request(`${BASE}/api/submit/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        viewer: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        submissionId: created.body.id,
        commentMessageId: commentId,
        text: 'hack',
      }),
    }),
    h.env,
    h.ctx,
  );
  assert.equal(foreign.status, 404);
});

test('收件箱：给管理员留言会私聊提醒管理员，管理员的回复也进收件箱', async () => {
  const h = webHarness({ WEB_REQUIRE_REVIEW: '0' });
  const viewer = 'ffffffffffffffffffffffffffffffff';
  const created = await postSubmission(h, { form: [{ key: 'viewer', value: viewer }] });

  const sent = await worker.fetch(
    new Request(`${BASE}/api/submit/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewer, submissionId: created.body.id, text: '请问什么时候能发布？' }),
    }),
    h.env,
    h.ctx,
  );
  await h.drain();
  assert.equal((await sent.json()).ok, true);
  const notice = h.fake.messagesTo(ADMIN_ID).find((m) => m.text?.includes('请问什么时候能发布'));
  assert.ok(notice, '管理员应该收到私聊提醒');

  // 管理员点「回复投稿者」→ 回复落到网页收件箱
  await h.dispatch(clickButton(h, `a:reply:${created.body.id}`, { userId: ADMIN_ID, chatId: ADMIN_ID }));
  await h.dispatch(privateMessage(h, '今晚就发', { userId: ADMIN_ID }));

  const inbox = await worker.fetch(new Request(`${BASE}/api/submit/inbox?t=${viewer}`), h.env, h.ctx);
  const item = (await inbox.json()).items[0];
  assert.ok(
    item.thread.some((message) => message.direction === 'to_author' && message.text.includes('今晚就发')),
    '管理员的回复要出现在收件箱里',
  );
  assert.ok(
    item.thread.some((message) => message.direction === 'to_admin' && message.text.includes('什么时候能发布')),
    '自己的留言也要能看到',
  );
});

test('表单定义接口：问卷前端照着它渲染，步骤与限制都在里面', async () => {
  const h = webHarness();
  const response = await worker.fetch(new Request(`${BASE}/api/submit/form`), h.env, h.ctx);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const form = body.form;
  assert.equal(form.captcha, true);
  assert.equal(form.maxFiles, 6);
  assert.equal(form.submitUrl, '/api/submit');
  assert.ok(
    form.steps.some((step) => step.type === 'media'),
    '要有媒体步骤',
  );
  const bodyStep = form.steps.find((step) => step.id === 'body');
  assert.equal(bodyStep.required, true);
  assert.equal(bodyStep.maxLength, 2000);
  const signatureStep = form.steps.find((step) => step.id === 'signature');
  assert.deepEqual(signatureStep.showIf, { step: 'author', equals: '自定义署名' }, '条件步骤要带上条件');
});

// ---------------- 额度保护：与 IP 无关的总闸 ----------------

test('网页投稿：全天硬上限与 IP 无关，换 IP 也拦得住', async () => {
  // 单 IP 限流挡不住 IP 池；这一道是"无论来多少 IP，一天最多收这么多"
  const clock = () => 1_000_000_000;
  const h = webHarness({ WEB_RATE_LIMIT_COUNT: '0', WEB_DAILY_LIMIT: '2', WEB_RATE_LIMIT_CLOCK: clock });

  const a = await postSubmission(h, { headers: { 'cf-connecting-ip': '1.1.1.1' } });
  assert.equal(a.status, 200);
  const b = await postSubmission(h, { headers: { 'cf-connecting-ip': '2.2.2.2' } });
  assert.equal(b.status, 200, '第二个 IP 还没到上限');

  const c = await postSubmission(h, { headers: { 'cf-connecting-ip': '3.3.3.3' } });
  assert.equal(c.status, 429, '换第三个 IP 也要被总闸拦下');
  assert.match(c.body.error, /今天的投稿量已满/);
  assert.equal(
    h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    2,
    '被总闸拦下的请求不能留下投稿记录',
  );
});

test('网页投稿：跨过零点，全天计数归零', async () => {
  let now = 1_000_000_000;
  const h = webHarness({ WEB_RATE_LIMIT_COUNT: '0', WEB_DAILY_LIMIT: '1', WEB_RATE_LIMIT_CLOCK: () => now });

  const first = await postSubmission(h, { headers: { 'cf-connecting-ip': '1.1.1.1' } });
  assert.equal(first.status, 200);
  const blocked = await postSubmission(h, { headers: { 'cf-connecting-ip': '2.2.2.2' } });
  assert.equal(blocked.status, 429);

  now += 86400; // 第二天
  const nextDay = await postSubmission(h, { headers: { 'cf-connecting-ip': '3.3.3.3' } });
  assert.equal(nextDay.status, 200, '新的一天桶是新的，不该接着前一天的计数');
});

test('网页投稿：待审积压到上限就停收，管理员审掉后自动恢复', async () => {
  const h = webHarness({
    WEB_RATE_LIMIT_COUNT: '0',
    WEB_PENDING_LIMIT: '1',
    ADMIN_CHAT_ID: String(REVIEW_CHAT),
  });

  const first = await postSubmission(h, { headers: { 'cf-connecting-ip': '1.1.1.1' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');

  const blocked = await postSubmission(h, { headers: { 'cf-connecting-ip': '2.2.2.2' } });
  assert.equal(blocked.status, 429, '积压满了就停收，和 IP 无关');
  assert.match(blocked.body.error, /待审核的投稿已经排满了/);

  // 管理员审掉这条 → pending 回落 → 立刻能再收
  const card = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('这是从网页提交的正文'));
  assert.ok(card, '审核群要收到卡片');
  await h.dispatch(clickButton(h, findButton(card, '通过'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));

  const afterReview = await postSubmission(h, { headers: { 'cf-connecting-ip': '3.3.3.3' } });
  assert.equal(afterReview.status, 200, '积压清掉后闸门要自动放开');
});

test('网页投稿：两个总闸都设 0 时等于关闭（保留可配置性）', async () => {
  const h = webHarness({ WEB_RATE_LIMIT_COUNT: '0', WEB_DAILY_LIMIT: '0', WEB_PENDING_LIMIT: '0' });
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
    const result = await postSubmission(h, { headers: { 'cf-connecting-ip': ip } });
    assert.equal(result.status, 200);
  }
});
