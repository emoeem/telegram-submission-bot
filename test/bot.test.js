/** 端到端测试：把 Worker 的 fetch 跑起来，驱动真实投稿流程。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { checkConfig, loadConfig } from '../src/config.js';
import { callbackDataOf, findButton } from './fake-telegram.js';
import {
  ADMIN_ID,
  REVIEW_CHAT,
  SECRET,
  TARGET_CHAT,
  USER_ID,
  clickButton,
  createHarness,
  groupCommand,
  privateAttachment,
  privateMessage,
  privatePhoto,
  privateReply,
} from './harness.js';

test('部署入口：/setup 设置 webhook，密钥不对或路径不对一律拒绝', async () => {
  const h = createHarness();

  const wrongSecret = await worker.fetch(new Request('https://bot.example/setup?secret=wrong'), h.env, h.ctx);
  assert.equal(wrongSecret.status, 403);

  const response = await worker.fetch(new Request(`https://bot.example/setup?secret=${SECRET}`), h.env, h.ctx);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.bot, '@test_bot');
  assert.equal(body.webhook_url, `https://bot.example/webhook/${SECRET}`);
  assert.deepEqual(body.problems, []);

  const setWebhook = h.fake.callsOf('setWebhook').at(-1);
  assert.equal(setWebhook.url, `https://bot.example/webhook/${SECRET}`);
  assert.equal(setWebhook.secret_token, SECRET);
  assert.ok(h.fake.callsOf('setMyCommands').length > 0, '顺便注册指令菜单');

  const notFound = await worker.fetch(
    new Request('https://bot.example/webhook/wrong', { method: 'POST', body: '{}' }),
    h.env,
    h.ctx,
  );
  assert.equal(notFound.status, 404);

  const health = await worker.fetch(new Request('https://bot.example/health'), h.env, h.ctx);
  assert.equal((await health.json()).ok, true);
});

/** 走完整个投稿流程，返回最后发给用户的那条消息。 */
async function submitViaWizard(
  harness,
  {
    category = '文字分享',
    title = null,
    body = '这是投稿正文',
    photos = [],
    author = '匿名投稿',
    signature = null,
    contact = null,
  } = {},
) {
  await harness.dispatch(privateMessage(harness, '/start'));
  await harness.dispatch(clickButton(harness, 'w:start'));

  let prompt = harness.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /第 1\/\d+ 步/);
  await harness.dispatch(clickButton(harness, findButton(prompt, category)));

  prompt = harness.fake.lastMessageTo(USER_ID);
  if (title === null) await harness.dispatch(clickButton(harness, findButton(prompt, '跳过')));
  else await harness.dispatch(privateMessage(harness, title));

  await harness.dispatch(privateMessage(harness, body));

  prompt = harness.fake.lastMessageTo(USER_ID);
  for (let index = 0; index < photos.length; index += 1) {
    await harness.dispatch(privatePhoto(harness, photos[index], `uniq-${index}-${photos[index]}`));
  }
  await harness.dispatch(clickButton(harness, findButton(prompt, photos.length > 0 ? '就这些了' : '跳过')));

  prompt = harness.fake.lastMessageTo(USER_ID);
  await harness.dispatch(clickButton(harness, findButton(prompt, author)));

  if (signature) {
    await harness.dispatch(privateMessage(harness, signature));
  }

  prompt = harness.fake.lastMessageTo(USER_ID);
  if (contact === null) await harness.dispatch(clickButton(harness, findButton(prompt, '跳过')));
  else await harness.dispatch(privateMessage(harness, contact));

  prompt = harness.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /请确认投稿内容/);
  assert.ok(!prompt.text.includes('{content}'), '确认页不应显示未替换的 {content} 占位符');
  await harness.dispatch(clickButton(harness, findButton(prompt, '确认发布')));
  return harness.fake.lastMessageTo(USER_ID);
}

function submissions(harness) {
  return harness.env.DB.raw.prepare('SELECT * FROM submissions ORDER BY id').all();
}

test('完整投稿流程：选项、文字、图片、署名分支，最后发布到群', async () => {
  const h = createHarness();

  await h.dispatch(privateMessage(h, '/start'));
  const welcome = h.fake.lastMessageTo(USER_ID);
  assert.match(welcome.text, /你好/);
  assert.equal(callbackDataOf(welcome, 0), 'w:start');

  await h.dispatch(clickButton(h, 'w:start'));
  let prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /第 1\/\d+ 步 · 默认投稿/);
  assert.deepEqual(
    (prompt.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    ['图片分享', '文字分享', '提问求助', '其他', '❌ 取消'],
  );

  // 分类
  await h.dispatch(clickButton(h, findButton(prompt, '图片分享')));
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /标题/);

  // 文本步骤里发图片：提示用文字回答，不能悄悄跳过这一项
  const beforeStray = h.fake.messagesTo(USER_ID).length;
  await h.dispatch(privatePhoto(h, 'stray_photo', 'uniq-stray'));
  assert.equal(h.fake.messagesTo(USER_ID).length, beforeStray + 1);
  assert.match(h.fake.lastMessageTo(USER_ID).text, /需要用文字回答/);
  const midway = h.env.DB.raw.prepare('SELECT data FROM sessions WHERE user_id = ?').get(USER_ID);
  assert.equal(JSON.parse(midway.data).title, undefined, '不该跳过标题这一步');

  // 标题
  await h.dispatch(privateMessage(h, '我的第一篇投稿'));
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /正文/);
  assert.ok(findButton(prompt, '上一步'));

  // 正文（带加粗格式）
  await h.dispatch(privateMessage(h, '重点看这里，其余随便', { entities: [{ type: 'bold', offset: 0, length: 5 }] }));
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /配图/);

  // 两张图片
  await h.dispatch(privatePhoto(h, 'photo_file_1', 'uniq1'));
  await h.dispatch(privatePhoto(h, 'photo_file_2', 'uniq2'));
  assert.deepEqual(
    h.fake.state.reactions.map((r) => r.emoji),
    ['✅', '✅'],
  );
  await h.dispatch(clickButton(h, findButton(prompt, '就这些了')));

  // 署名：走「自定义署名」分支
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /署名/);
  await h.dispatch(clickButton(h, findButton(prompt, '自定义署名')));
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /请输入想显示的署名/);
  await h.dispatch(privateMessage(h, '阿强'));

  // 联系方式
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /联系方式/);
  await h.dispatch(privateMessage(h, '@aqiang'));

  // 确认
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /请确认投稿内容/);
  assert.ok(!prompt.text.includes('{content}'), '确认页不应显示未替换的 {content} 占位符');
  assert.match(prompt.text, /阿强/);
  await h.dispatch(clickButton(h, findButton(prompt, '确认发布')));

  // —— 群里的结果 ——
  const groupMessages = h.fake.messagesTo(TARGET_CHAT);
  assert.equal(groupMessages.length, 3, '两张图（相册）+ 一条正文');
  const [photoFirst, photoSecond, post] = groupMessages;
  assert.equal(photoFirst.photo, 'photo_file_1');
  assert.equal(photoSecond.photo, 'photo_file_2');
  assert.match(photoFirst.caption, /#投稿 #图片分享 #图片/, '自动带上分类和类型标签');
  assert.match(post.text, /#投稿 #图片分享 #图片/);
  assert.match(post.text, /<b>我的第一篇投稿<\/b>/);
  assert.match(post.text, /<b>重点看这里<\/b>，其余随便/, '正文的加粗格式要保留');
  assert.match(post.text, /投稿者：阿强/);
  assert.match(post.text, /联系方式：@aqiang/);
  assert.deepEqual(
    (post.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    ['💬 评论', '💬 回复投稿者', '✏️ 编辑', '📌 置顶', '🧹 撤下', '🚫 拉黑'],
  );
  // 第一条是"人人可用"的公开评论入口（URL 深链，不受隐私模式影响）
  const commentButton = (post.keyboard.inline_keyboard ?? []).flat()[0];
  assert.match(commentButton.url ?? '', /^https:\/\/t\.me\/test_bot\?start=c_1$/, '要指向机器人并带上投稿 ID');

  // —— 用户收到的回执 ——
  const receipt = h.fake.lastMessageTo(USER_ID);
  assert.match(receipt.text, /投稿已发布/);
  assert.match(receipt.text, /https:\/\/t\.me\/test_group\/\d+/);

  // —— 数据库 ——
  const rows = submissions(h);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'published');
  assert.equal(rows[0].publish_message_id, post.message_id);
  assert.equal(rows[0].media_message_id, photoFirst.message_id);
  const saved = JSON.parse(rows[0].data);
  assert.deepEqual(
    saved.photos.map((item) => [item.kind, item.fileId]),
    [
      ['photo', 'photo_file_1'],
      ['photo', 'photo_file_2'],
    ],
  );

  // 用户的消息被自动清理（正文/标题等）
  assert.ok(h.fake.state.deletions.some((d) => d.chatId === USER_ID));

  // —— 管理员回复投稿者 ——
  await h.dispatch(clickButton(h, findButton(post, '回复投稿者'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const adminPrompt = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(adminPrompt.text, /请直接发送要转达给投稿者的话/);
  await h.dispatch(privateMessage(h, '恭喜，已经帮你发出去了', { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /管理员回复：\n恭喜，已经帮你发出去了/);

  // —— 管理员撤下投稿 ——
  const groupPost = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('#投稿'));
  await h.dispatch(clickButton(h, findButton(groupPost, '撤下'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const deletedIds = h.fake.state.deletions.filter((d) => d.chatId === TARGET_CHAT).map((d) => d.messageId);
  assert.ok(deletedIds.includes(post.message_id), '正文消息被删除');
  assert.ok(deletedIds.includes(photoFirst.message_id), '相册消息被删除');
  assert.equal(submissions(h)[0].status, 'recalled');

  // —— 拉黑后不能再投稿 ——
  await h.dispatch(clickButton(h, findButton(groupPost, '拉黑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(privateMessage(h, '/start'));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /投稿权限已被限制/);
  await h.dispatch(clickButton(h, 'w:start'));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /投稿权限已被限制/);
});

test('审核模式：先发审核群，管理员通过后才公开', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });

  const receipt = await submitViaWizard(h, { body: '审核模式投稿', photos: ['p1', 'p2', 'p3'] });
  assert.match(receipt.text, /管理员审核/);

  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0, '未审核前不能出现在目标群');
  const reviewPosts = h.fake.messagesTo(REVIEW_CHAT);
  const reviewPost = reviewPosts.find((m) => m.text?.includes('审核模式投稿'));
  assert.ok(reviewPost, '审核群里应该收到投稿');
  assert.deepEqual(
    (reviewPost.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    ['✅ 通过', '❌ 拒绝', '✏️ 编辑', '💬 回复投稿者', '🚫 拉黑'],
  );
  assert.equal(submissions(h)[0].status, 'pending');

  await h.dispatch(clickButton(h, findButton(reviewPost, '通过'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));

  const published = h.fake.messagesTo(TARGET_CHAT);
  const post = published.find((m) => m.text?.includes('审核模式投稿'));
  assert.ok(post, '通过后应该发到目标群');
  assert.match(h.fake.lastMessageTo(USER_ID).text, /已通过审核并发布/);
  assert.equal(submissions(h)[0].status, 'published');
  assert.match(h.fake.state.edits.at(-1).text, /已通过/);
});

test('审核模式：拒绝时可以选预设理由，也可以自己写一句', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });

  await submitViaWizard(h, { body: '这条会被拒绝' });
  const reviewPost = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('这条会被拒绝'));

  // 点「拒绝」先把预设理由摆出来
  await h.dispatch(clickButton(h, findButton(reviewPost, '拒绝'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  const prompting = h.fake
    .messagesTo(REVIEW_CHAT)
    .filter((m) => m.text?.includes('请选择驳回理由'))
    .at(-1);
  assert.ok(prompting, '应该显示预设理由');
  assert.deepEqual(
    (prompting.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    [
      '内容与本群主题无关',
      '广告或推广内容',
      '含违规内容',
      '重复投稿',
      '内容太乱，请整理后再投',
      '✏️ 自己写一句',
      '🚫 不给理由',
    ],
  );

  // 选一个预设理由 → 立刻驳回并转告投稿者
  await h.dispatch(clickButton(h, findButton(prompting, '广告或推广内容'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /没有通过审核/);
  assert.match(h.fake.lastMessageTo(USER_ID).text, /广告或推广内容/);
  assert.equal(submissions(h)[0].status, 'rejected');
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0);
  assert.match(h.fake.state.edits.at(-1).text, /已拒绝：广告或推广内容/);

  // 再投一条，走「自己写一句」的路子
  await submitViaWizard(h, { body: '第二条投稿' });
  const second = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('第二条投稿'));
  await h.dispatch(clickButton(h, findButton(second, '拒绝'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  const secondPrompt = h.fake
    .messagesTo(REVIEW_CHAT)
    .filter((m) => m.text?.includes('请选择驳回理由'))
    .at(-1);
  await h.dispatch(clickButton(h, findButton(secondPrompt, '自己写一句'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /把驳回理由发给我/);
  await h.dispatch(privateMessage(h, '内容和本群无关，抱歉', { userId: ADMIN_ID }));

  assert.match(h.fake.lastMessageTo(USER_ID).text, /没有通过审核/);
  assert.match(h.fake.lastMessageTo(USER_ID).text, /内容和本群无关，抱歉/);
  assert.equal(submissions(h)[1].status, 'rejected');
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0);
});

test('频率限制、重复更新去重、配置缺失', async () => {
  const h = createHarness({ RATE_LIMIT_COUNT: '1', RATE_LIMIT_WINDOW_SECONDS: '3600' });

  await submitViaWizard(h, { body: '第一次投稿' });
  assert.equal(submissions(h).length, 1);

  await submitViaWizard(h, { body: '第二次投稿' });
  assert.match(h.fake.lastMessageTo(USER_ID).text, /投稿太频繁/);
  assert.equal(submissions(h).length, 1, '被限流时不应该入库');

  // 同一条 update 重复投递只处理一次
  const duplicatePayload = privateMessage(h, '/start');
  const first = await h.dispatchWith(9001, duplicatePayload);
  const second = await h.dispatchWith(9001, duplicatePayload);
  assert.equal(first.status, 200);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });

  // 配置缺 TARGET_CHAT_ID 时：/chatid 依旧可用（部署第一步就靠它拿群 ID），但投稿会被拦住
  const broken = createHarness({ TARGET_CHAT_ID: '' });
  const response = await broken.dispatch(groupCommand(broken, '/chatid'));
  assert.equal(response.status, 200);
  assert.match(broken.fake.lastMessageTo(TARGET_CHAT).text, new RegExp(String(TARGET_CHAT)));
  await broken.dispatch(privateMessage(broken, '/start', { userId: ADMIN_ID }));
  assert.match(broken.fake.lastMessageTo(ADMIN_ID).text, /\/bind/);
});

test('权限与辅助指令：非管理员不能用管理指令，/chatid 可用', async () => {
  const h = createHarness();

  await h.dispatch(groupCommand(h, '/stats', { userId: USER_ID }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /只有管理员能用/);

  await h.dispatch(groupCommand(h, '/chatid'));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, new RegExp(String(TARGET_CHAT)));

  await h.dispatch(privateMessage(h, '/myid'));
  assert.match(h.fake.lastMessageTo(USER_ID).text, new RegExp(String(USER_ID)));

  await h.dispatch(groupCommand(h, '/ban 4242 刷屏'));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /已拉黑用户 4242/);
  await h.dispatch(groupCommand(h, '/banlist'));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /4242<\/code> · 刷屏/);
  await h.dispatch(groupCommand(h, '/unban 4242'));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /已解除拉黑 4242/);
});

test('被拉进群时，机器人会私聊告知本群 ID', async () => {
  const groupJoined = {
    my_chat_member: {
      chat: { id: -1009999, type: 'supergroup', title: '我的交流群' },
      from: { id: ADMIN_ID, is_bot: false, first_name: '管理员' },
      new_chat_member: { status: 'member', user: { id: 42, is_bot: true } },
    },
  };

  const h = createHarness();
  await h.dispatch(groupJoined);
  const dm = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(dm.text, /本群 ID/);
  assert.match(dm.text, /-1009999/);
  assert.match(dm.text, /TARGET_CHAT_ID/);

  // 已经是配置好的目标群，就别再说"去填配置"
  const configured = createHarness({ TARGET_CHAT_ID: '-1009999' });
  await configured.dispatch(groupJoined);
  assert.match(configured.fake.lastMessageTo(ADMIN_ID).text, /可以开始用了/);
});

test('不用重新部署：在群里发 /bind 就能设成发布群，之后投稿直接可用', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' });
  const groupId = -1001234567890;

  // 绑定之前：管理员发 /start 会被拦下，并被告知用 /bind
  await h.dispatch(privateMessage(h, '/start', { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /还没配置完成/);
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /\/bind/);

  // 群里发一条指令完成绑定
  await h.dispatch(groupCommand(h, '/bind', { chatId: groupId }));
  assert.match(h.fake.lastMessageTo(groupId).text, /已把本群设为投稿发布群/);
  const stored = h.env.DB.raw.prepare("SELECT value FROM settings WHERE key = 'target_chat_id'").get();
  assert.equal(stored.value, String(groupId));

  // 绑定后投稿完全可用，并且发到刚绑定的群
  const receipt = await submitViaWizard(h, { body: '绑定之后发的投稿' });
  assert.match(receipt.text, /投稿已发布/);
  const posted = h.fake.messagesTo(groupId).find((m) => m.text?.includes('绑定之后发的投稿'));
  assert.ok(posted, '投稿应该发到 /bind 设定的群里');
  assert.ok(h.fake.messagesTo(TARGET_CHAT).length <= 1, 'TARGET_CHAT_ID 没配就不该往那边发');

  // 审核模式必须配独立审核群：没配时拒绝开启（否则未审核草稿会直接出现在公开群）
  await h.dispatch(groupCommand(h, '/review on', { chatId: groupId }));
  assert.match(h.fake.lastMessageTo(groupId).text, /没有配置独立的审核群/);
  await h.dispatch(groupCommand(h, '/review off', { chatId: groupId }));
  assert.match(h.fake.lastMessageTo(groupId).text, /审核模式已关闭/);

  await h.dispatch(groupCommand(h, '/settings', { chatId: groupId }));
  const settings = h.fake.lastMessageTo(groupId).text;
  assert.match(settings, new RegExp(String(groupId)));
  assert.match(settings, /审核模式：关闭/);
  assert.match(settings, /\/bind 设定的/);
});

test('论坛群：在哪个话题里 /bind，投稿就发到那个话题', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' });
  const forumId = -1001234567890;
  const topicId = 27;

  await h.dispatch(groupCommand(h, '/bind', { chatId: forumId, threadId: topicId }));
  assert.match(h.fake.lastMessageTo(forumId).text, /本话题/);

  const receipt = await submitViaWizard(h, { body: '发到指定话题的投稿' });
  assert.match(receipt.text, /投稿已发布/);

  const posted = h.fake.messagesTo(forumId).find((m) => m.text?.includes('发到指定话题的投稿'));
  assert.ok(posted, '投稿应该发到绑定的群');
  assert.equal(posted.threadId, topicId, '应该带着话题 ID 发布');

  await h.dispatch(groupCommand(h, '/settings', { chatId: forumId, threadId: topicId }));
  assert.match(h.fake.lastMessageTo(forumId).text, new RegExp(`发布话题：${topicId}`));
});

test('发布目标：话题被关闭时先自动重开，投稿仍然发在原话题（绑定不会被清掉）', async () => {
  const targetId = -1001234567890;
  const topicId = 27;
  // 模拟"话题被关着"：重开之前发进这个话题会被 Telegram 拒绝
  let closed = true;
  const h = createHarness(
    { TARGET_CHAT_ID: '' },
    {
      failures: {
        sendPhoto: (params) =>
          closed && Number(params.chat_id) === targetId && params.message_thread_id
            ? 'Bad Request: TOPIC_CLOSED'
            : null,
        reopenForumTopic: () => {
          closed = false;
          return null;
        },
      },
    },
  );

  await h.dispatch(groupCommand(h, '/bind', { chatId: targetId, threadId: topicId }));
  const receipt = await submitViaWizard(h, { category: '图片分享', body: '话题重开测试', photos: ['photo-1'] });
  assert.match(receipt.text, /投稿已发布/);

  const reopenCalls = h.fake.callsOf('reopenForumTopic');
  assert.equal(reopenCalls.length, 1, '应该尝试重开被关闭的话题');
  assert.equal(reopenCalls[0].message_thread_id, topicId);

  const photoCalls = h.fake.callsOf('sendPhoto').filter((call) => Number(call.chat_id) === targetId);
  assert.equal(photoCalls.length, 2, '先发话题失败，重开话题后再发一次');
  assert.equal(photoCalls[0].message_thread_id, topicId);
  assert.equal(photoCalls[1].message_thread_id, topicId, '重开成功后仍然发在原话题');

  const post = h.fake.messagesTo(targetId).find((m) => m.text?.includes('话题重开测试'));
  assert.ok(post, '正文应该发布出去');
  assert.equal(post.threadId, topicId, '正文跟着媒体落在原话题');

  const target = h.env.DB.raw.prepare('SELECT thread_id FROM publish_targets WHERE chat_id = ?').get(targetId);
  assert.equal(target.thread_id, topicId, '话题绑定必须保留，不能被清成 null');
});

test('发布目标：重开话题没权限时只回退这一条到主聊天，通知管理员且绑定保留', async () => {
  const targetId = -1001234567890;
  const topicId = 27;
  const h = createHarness(
    { TARGET_CHAT_ID: '' },
    {
      failures: {
        sendPhoto: (params) =>
          Number(params.chat_id) === targetId && params.message_thread_id ? 'Bad Request: TOPIC_CLOSED' : null,
        reopenForumTopic: () => 'Bad Request: CHAT_ADMIN_REQUIRED',
      },
    },
  );

  await h.dispatch(groupCommand(h, '/bind', { chatId: targetId, threadId: topicId }));
  const receipt = await submitViaWizard(h, { category: '图片分享', body: '权限不足回退测试', photos: ['photo-1'] });
  assert.match(receipt.text, /投稿已发布/);

  const post = h.fake.messagesTo(targetId).find((m) => m.text?.includes('权限不足回退测试'));
  assert.ok(post, '正文应该成功发布');
  assert.equal(post.threadId, null, '这一条临时落在主聊天');

  const target = h.env.DB.raw.prepare('SELECT thread_id FROM publish_targets WHERE chat_id = ?').get(targetId);
  assert.equal(target.thread_id, topicId, '绑定保持不变：话题重开后投稿会自动回到话题里');

  const notice = h.fake.messagesTo(ADMIN_ID).find((m) => m.text?.includes('已被关闭'));
  assert.ok(notice, '应该私聊提醒管理员去处理，而不是静默掉进主聊天');
});

test('/topic：在话题里发就设成那个话题，/topic off 回到主聊天', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' });
  const forumId = -1001234567890;

  // 没绑定的会话先提示去 /bind
  await h.dispatch(groupCommand(h, '/topic', { chatId: forumId, threadId: 55 }));
  assert.match(h.fake.lastMessageTo(forumId).text, /还不是发布目标/);

  await h.dispatch(groupCommand(h, '/bind', { chatId: forumId }));
  await h.dispatch(groupCommand(h, '/topic', { chatId: forumId, threadId: 55 }));
  assert.match(h.fake.lastMessageTo(forumId).text, /当前话题/);

  await submitViaWizard(h, { body: 'topic 切换后的投稿' });
  const posted = h.fake.messagesTo(forumId).find((m) => m.text?.includes('topic 切换后的投稿'));
  assert.equal(posted.threadId, 55, '/topic 之后投稿应该发到那个话题');

  await h.dispatch(groupCommand(h, '/topic off', { chatId: forumId }));
  assert.match(h.fake.lastMessageTo(forumId).text, /主聊天区/);

  await submitViaWizard(h, { body: '回到主聊天后的投稿' });
  const back = h.fake.messagesTo(forumId).find((m) => m.text?.includes('回到主聊天后的投稿'));
  assert.equal(back.threadId, null, '/topic off 之后投稿回到主聊天');

  // 非 Owner（哪怕是管理员）不能改发布话题
  await h.dispatch(privateMessage(h, '/addadmin 777 moderator', { userId: ADMIN_ID }));
  await h.dispatch(groupCommand(h, '/topic', { chatId: forumId, threadId: 88, userId: 777 }));
  assert.match(h.fake.lastMessageTo(forumId).text, /只有所有者/);
  const unchanged = h.env.DB.raw.prepare('SELECT thread_id FROM publish_targets WHERE chat_id = ?').get(forumId);
  assert.equal(unchanged.thread_id, null, '被拒绝的操作不能改动绑定');
});

test('论坛群：在主聊天 /bind 时提示怎么改到指定话题', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' }, { isForum: true });
  const forumId = -1001234567890;
  await h.dispatch(groupCommand(h, '/bind', { chatId: forumId }));
  const text = h.fake.lastMessageTo(forumId).text;
  assert.match(text, /主聊天/);
  assert.match(text, /\/topic/, '应该告诉管理员：想发到某个话题就进那个话题发 /topic');
});

test('发布目标：General 话题关闭时自动重开后继续发布正文', async () => {
  const targetId = -1001234567890;
  let sendMessageAttempts = 0;
  const h = createHarness(
    { TARGET_CHAT_ID: '' },
    {
      failures: {
        sendMessage: (params) => {
          if (Number(params.chat_id) !== targetId || !String(params.text).includes('General 关闭回退测试')) return null;
          sendMessageAttempts += 1;
          return sendMessageAttempts === 1 ? 'Bad Request: TOPIC_CLOSED' : null;
        },
      },
    },
  );

  await h.dispatch(groupCommand(h, '/bind', { chatId: targetId }));
  const receipt = await submitViaWizard(h, { body: 'General 关闭回退测试' });
  assert.match(receipt.text, /投稿已发布/);

  const reopenCalls = h.fake.callsOf('reopenGeneralForumTopic').filter((call) => Number(call.chat_id) === targetId);
  assert.equal(reopenCalls.length, 1, 'General 关闭后应该自动调用 reopenGeneralForumTopic');

  const publishCalls = h.fake
    .callsOf('sendMessage')
    .filter((call) => Number(call.chat_id) === targetId && String(call.text).includes('General 关闭回退测试'));
  assert.equal(publishCalls.length, 2, '正文应先失败，再在重开 General 后重试');
  assert.equal(publishCalls[0].message_thread_id, undefined);
  assert.equal(publishCalls[1].message_thread_id, undefined);

  const post = h.fake.messagesTo(targetId).find((m) => m.text?.includes('General 关闭回退测试'));
  assert.ok(post, '重开 General 后正文应该成功发布');
});

test('双向匿名对话：用户和管理员能来回聊，互不见身份', async () => {
  const h = createHarness();
  await submitViaWizard(h, { body: '想问问大家周末有空吗' });
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('想问问大家周末有空吗'));

  // 管理员点「回复投稿者」→ 私聊里输入 → 转达给投稿者
  await h.dispatch(clickButton(h, findButton(post, '回复投稿者'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /要转达给投稿者的话/);
  await h.dispatch(privateMessage(h, '周末有活动，欢迎来', { userId: ADMIN_ID }));

  const toUser = h.fake.lastMessageTo(USER_ID);
  assert.match(toUser.text, /管理员回复：\n周末有活动，欢迎来/);
  assert.match(toUser.text, /直接回复这条消息就能接着说/, '要告诉用户怎么继续聊');
  assert.deepEqual(
    (toUser.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    ['💬 接着说'],
  );

  // 用户直接回复那条消息 → 群里原投稿下面出现补充
  await h.dispatch(privateReply(h, toUser, '那我报名！'));
  const followUp = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('作者补充'));
  assert.ok(followUp, '补充内容应该出现在群里');
  assert.match(followUp.text, /那我报名！/);
  assert.equal(followUp.reply_to, post.message_id, '补充要挂在原投稿下面');
  assert.deepEqual(
    (followUp.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    ['💬 回复投稿者', '🚫 拉黑'],
  );
  // 用户在私聊里收到的确认是表情回执，不刷屏
  assert.equal(h.fake.state.reactions.at(-1).emoji, '✅');

  // 管理员点那条补充下面的「回复投稿者」→ 又回到用户私聊
  // （注意：在群里"直接回复"现在一律算公开评论，不再隐式转成私聊）
  await h.dispatch(clickButton(h, findButton(followUp, '回复投稿者'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(privateMessage(h, '收到，我把你记上了', { userId: ADMIN_ID }));
  const second = h.fake.lastMessageTo(USER_ID);
  assert.match(second.text, /管理员回复：\n收到，我把你记上了/);

  // 用户点「接着说」也能继续（不需要回复消息）
  await h.dispatch(clickButton(h, findButton(second, '接着说')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /直接发你想说的话/);
  await h.dispatch(privateMessage(h, '还有一个问题'));
  const third = h.fake
    .messagesTo(TARGET_CHAT)
    .filter((m) => m.text?.includes('作者补充'))
    .at(-1);
  assert.match(third.text, /还有一个问题/);
});

test('审核体验：历史投稿数、改文案后发布、批量通过', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });

  await submitViaWizard(h, { body: '第一次投稿' });
  await submitViaWizard(h, { body: '第二次投稿' });

  // 审核消息里带着这位投稿者的历史
  const second = h.fake
    .messagesTo(REVIEW_CHAT)
    .filter((m) => m.text?.includes('第二次投稿'))
    .at(-1);
  assert.match(second.text, /这位投稿者：累计 2 次投稿/);
  assert.match(second.text, /待审 2/);

  // 改文案：机器人私聊给草稿，管理员发回改好的版本 → 直接按新版发布
  await h.dispatch(clickButton(h, findButton(second, '编辑'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  const editMenu = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(editMenu.text, /想改哪一部分/, '「编辑」应先给改文案/改媒体的分叉');
  assert.deepEqual(
    (editMenu.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    ['📝 改文案', '🎬 改媒体'],
  );
  await h.dispatch(clickButton(h, findButton(editMenu, '改文案'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /这是当前文案/);
  await h.dispatch(privateMessage(h, '#投稿 #修改版\n\n管理员帮你润色过的内容', { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /已更新群里的投稿/);

  const published = h.fake.messagesTo(TARGET_CHAT);
  assert.ok(
    published.some((m) => m.text?.includes('管理员帮你润色过的内容')),
    '应该按管理员改过的版本发布',
  );
  assert.ok(!published.some((m) => m.text?.includes('第二次投稿')), '原版不该再发出去');
  assert.match(h.fake.lastMessageTo(USER_ID).text, /已通过审核并发布/);

  // 剩下的用 /approve_all 一次通过
  await h.dispatch(groupCommand(h, '/approve_all', { chatId: REVIEW_CHAT }));
  assert.match(h.fake.lastMessageTo(REVIEW_CHAT).text, /已通过 1 条待审核投稿/);
  assert.ok(h.fake.messagesTo(TARGET_CHAT).some((m) => m.text?.includes('第一次投稿')));
  const statuses = submissions(h).map((row) => row.status);
  assert.deepEqual(statuses, ['published', 'published']);

  await h.dispatch(groupCommand(h, '/approve_all', { chatId: REVIEW_CHAT }));
  assert.match(h.fake.lastMessageTo(REVIEW_CHAT).text, /没有待审核的投稿/);
});

test('防滥用：敏感词、链接、重复投稿、新用户冷却', async () => {
  const blockedWordHarness = createHarness({ BANNED_WORDS: '违禁,赌博' });
  await submitViaWizard(blockedWordHarness, { body: '这里有违禁内容' });
  assert.match(blockedWordHarness.fake.lastMessageTo(USER_ID).text, /不允许的用词：「违禁」/);
  assert.equal(submissions(blockedWordHarness).length, 0, '拦截时不该入库');
  assert.ok(blockedWordHarness.fake.messagesTo(TARGET_CHAT).length === 0, '拦截时不该发到群里');

  const linkHarness = createHarness({ BLOCK_LINKS: '1' });
  await submitViaWizard(linkHarness, { body: '看这个 https://spam.example.com/x' });
  assert.match(linkHarness.fake.lastMessageTo(USER_ID).text, /不能带链接/);
  assert.equal(submissions(linkHarness).length, 0);

  const duplicateHarness = createHarness({ DUPLICATE_WINDOW_SECONDS: '3600' });
  await submitViaWizard(duplicateHarness, { body: '重复的内容' });
  await submitViaWizard(duplicateHarness, { body: '重复的内容' });
  assert.match(duplicateHarness.fake.lastMessageTo(USER_ID).text, /别重复投稿/);
  assert.equal(submissions(duplicateHarness).length, 1);

  const cooldownHarness = createHarness({ NEW_USER_COOLDOWN_SECONDS: '300' });
  await submitViaWizard(cooldownHarness, { body: '刚认识就投稿' });
  assert.match(cooldownHarness.fake.lastMessageTo(USER_ID).text, /第一次投稿前先等/);
  assert.equal(submissions(cooldownHarness).length, 0);

  // 审核模式下敏感词不拦人，而是标给管理员看
  const reviewHarness = createHarness({
    REQUIRE_REVIEW: '1',
    ADMIN_CHAT_ID: String(REVIEW_CHAT),
    BANNED_WORDS: '违禁',
  });
  await submitViaWizard(reviewHarness, { body: '这条含违禁词' });
  const review = reviewHarness.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('这条含违禁词'));
  assert.match(review.text, /自动检查发现：敏感词「违禁」/);
});

test('菜单：主菜单直接给出「我的投稿」入口，不用记 /my', async () => {
  const h = createHarness();
  await h.dispatch(privateMessage(h, '/start'));
  const menu = h.fake.lastMessageTo(USER_ID);
  const button = (menu.keyboard?.inline_keyboard ?? []).flat().find((b) => b.callback_data === 'w:my');
  assert.ok(button, '主菜单里要有「我的投稿」按钮');
  await h.dispatch(clickButton(h, 'w:my'));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /你还没有投过稿/);
});

test('防滥用：投稿前需要点对表情验证，点错只换题不刷屏', async () => {
  const h = createHarness({ CAPTCHA: '1' });

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  const captcha = h.fake.lastMessageTo(USER_ID);
  assert.match(captcha.text, /请点出下面的/);
  // 题目里那句「请点出下面的 x」里的 x 一定对应其中一个按钮
  const buttons = (captcha.keyboard.inline_keyboard ?? []).flat();
  assert.equal(buttons.length, 4);
  const target = buttons.map((b) => b.text).find((text) => captcha.text.includes(text));
  assert.ok(target, '验证题里必须点名其中一个表情');

  // 先点错：同一条消息原地换题，不再往聊天里多发一条
  const before = h.fake.messagesTo(USER_ID).length;
  const wrong = buttons.find((b) => b.text !== target);
  await h.dispatch(clickButton(h, wrong.callback_data));
  assert.equal(h.fake.messagesTo(USER_ID).length, before, '点错不应该新增消息');
  const retry = h.fake.lastMessageTo(USER_ID);
  assert.match(retry.text, /请点出下面的/);
  assert.match(retry.text, /已换一道题/);
  assert.match(retry.text, /还有 2 次机会/);

  // 再点对（用换题后的按钮），进入第一步
  const again = h.fake.lastMessageTo(USER_ID);
  const buttons2 = (again.keyboard.inline_keyboard ?? []).flat();
  const target2 = buttons2.map((b) => b.text).find((text) => again.text.includes(text));
  const right = buttons2.find((b) => b.text === target2);
  await h.dispatch(clickButton(h, right.callback_data));
  const firstStep = h.fake.lastMessageTo(USER_ID);
  assert.match(firstStep.text, /第 1\/\d+ 步/);
  assert.match(firstStep.text, /这次投稿属于哪一类/);
});

test('防滥用：表情验证连错三次才取消，取消后给出重新开始的按钮', async () => {
  const h = createHarness({ CAPTCHA: '1' });

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt = h.fake.lastMessageTo(USER_ID);
    const buttons = (prompt.keyboard?.inline_keyboard ?? []).flat();
    const target = buttons.map((b) => b.text).find((text) => prompt.text.includes(text));
    const wrong = buttons.find((b) => b.text !== target);
    await h.dispatch(clickButton(h, wrong.callback_data));
  }
  const failed = h.fake.lastMessageTo(USER_ID);
  assert.match(failed.text, /验证失败/);
  const buttons = (failed.keyboard?.inline_keyboard ?? []).flat();
  assert.ok(
    buttons.some((b) => b.callback_data === 'w:start'),
    '取消验证后要能一键重新开始',
  );
});

test('内容类型：视频、文件、投票、位置都能投稿，超过 10 张图自动分批', async () => {
  const mixed = createHarness();
  await mixed.dispatch(privateMessage(mixed, '/start'));
  await mixed.dispatch(clickButton(mixed, 'w:start'));
  await mixed.dispatch(clickButton(mixed, findButton(mixed.fake.lastMessageTo(USER_ID), '文字分享')));
  await mixed.dispatch(clickButton(mixed, findButton(mixed.fake.lastMessageTo(USER_ID), '跳过')));
  await mixed.dispatch(privateMessage(mixed, '附件大合集'));

  const mediaPrompt = mixed.fake.lastMessageTo(USER_ID);
  assert.match(mediaPrompt.text, /图片、视频、文件、语音、位置/);
  await mixed.dispatch(privatePhoto(mixed, 'photo_1', 'u1'));
  await mixed.dispatch(privateAttachment(mixed, 'video', 'video_1', 'uv1'));
  await mixed.dispatch(privateAttachment(mixed, 'document', 'doc_1', 'ud1'));
  await mixed.dispatch(privateAttachment(mixed, 'voice', 'voice_1', 'uo1'));
  await mixed.dispatch(
    privateAttachment(mixed, 'poll', 'poll_1', 'up1', {
      extra: { question: '周末去哪儿？', options: ['爬山', '看电影'] },
    }),
  );
  await mixed.dispatch(privateAttachment(mixed, 'location', 'loc_1', 'ul1'));
  await mixed.dispatch(clickButton(mixed, findButton(mediaPrompt, '就这些了')));

  // 署名 → 联系方式 → 确认页
  await mixed.dispatch(clickButton(mixed, findButton(mixed.fake.lastMessageTo(USER_ID), '匿名投稿')));
  await mixed.dispatch(clickButton(mixed, findButton(mixed.fake.lastMessageTo(USER_ID), '跳过')));
  const preview = mixed.fake.lastMessageTo(USER_ID);
  assert.match(preview.text, /请确认投稿内容/);
  assert.match(preview.text, /图片×1/);
  assert.match(preview.text, /视频×1/);
  assert.match(preview.text, /文件×1/);
  assert.match(preview.text, /语音×1/);
  assert.match(preview.text, /投票×1/);
  assert.match(preview.text, /位置×1/);
  await mixed.dispatch(clickButton(mixed, findButton(preview, '确认发布')));

  const posted = mixed.fake.messagesTo(TARGET_CHAT);
  // 图片和视频会合成一个相册发出去（私聊里的预览相册不算，只看目标群）
  const groups = mixed.fake.callsOf('sendMediaGroup').filter((call) => Number(call.chat_id) === TARGET_CHAT);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].media.map((item) => item.type),
    ['photo', 'video'],
  );
  // 文件、语音、投票、位置各自单独发
  const kinds = posted.map((m) => m.kind).filter(Boolean);
  assert.ok(kinds.includes('document'), '文件要发出去');
  assert.ok(kinds.includes('voice'), '语音要发出去');
  assert.ok(kinds.includes('poll'), '投票要发出去');
  assert.ok(kinds.includes('location'), '位置要发出去');
  const poll = posted.find((m) => m.kind === 'poll');
  assert.equal(poll.poll.question, '周末去哪儿？');
  assert.deepEqual(
    poll.poll.options.map((o) => o.text),
    ['爬山', '看电影'],
  );
  assert.match(
    posted.find((m) => m.text?.includes('附件大合集')).text,
    /#投稿 #文字分享 #图片 #视频 #文件 #语音 #投票 #位置/,
  );

  // 12 张图 → 自动拆成 10 + 2 两个相册
  const many = createHarness({ MAX_ATTACHMENTS: '12' });
  await many.dispatch(privateMessage(many, '/start'));
  await many.dispatch(clickButton(many, 'w:start'));
  await many.dispatch(clickButton(many, findButton(many.fake.lastMessageTo(USER_ID), '文字分享')));
  await many.dispatch(clickButton(many, findButton(many.fake.lastMessageTo(USER_ID), '跳过')));
  await many.dispatch(privateMessage(many, '十二张图'));
  const promptMany = many.fake.lastMessageTo(USER_ID);
  for (let index = 1; index <= 12; index += 1) {
    await many.dispatch(privatePhoto(many, `p${index}`, `u${index}`));
  }
  await many.dispatch(clickButton(many, findButton(promptMany, '就这些了')));
  await many.dispatch(clickButton(many, findButton(many.fake.lastMessageTo(USER_ID), '匿名投稿')));
  await many.dispatch(clickButton(many, findButton(many.fake.lastMessageTo(USER_ID), '跳过')));
  await many.dispatch(clickButton(many, findButton(many.fake.lastMessageTo(USER_ID), '确认发布')));

  const photoGroups = many.fake.callsOf('sendMediaGroup').filter((call) => Number(call.chat_id) === TARGET_CHAT);
  assert.equal(photoGroups.length, 2, '12 张图应该分成两个相册');
  assert.deepEqual(
    photoGroups.map((call) => call.media.length),
    [10, 2],
  );
});

test('已发布投稿：编辑、置顶、撤下后重新发布', async () => {
  const h = createHarness();
  await submitViaWizard(h, { body: '一条会被操作的投稿', photos: ['p1', 'p2'] });
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('一条会被操作的投稿'));

  // 置顶
  await h.dispatch(clickButton(h, findButton(post, '置顶'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  assert.equal(h.fake.callsOf('pinChatMessage').at(-1).message_id, post.message_id);
  assert.match(h.fake.callsOf('answerCallbackQuery').at(-1).text, /已置顶投稿/);

  // 编辑已发布：私聊发回新文案 → 改写群里那条
  await h.dispatch(clickButton(h, findButton(post, '编辑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const editMenu = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(editMenu.text, /想改哪一部分/);
  await h.dispatch(clickButton(h, findButton(editMenu, '改文案'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /这是当前文案/);
  await h.dispatch(privateMessage(h, '#投稿 #改过了\n\n这是管理员改过的版本', { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /已更新群里的投稿/);
  assert.equal(h.fake.state.edits.at(-1).messageId, post.message_id);
  assert.match(h.fake.state.edits.at(-1).text, /这是管理员改过的版本/);
  assert.equal(submissions(h)[0].override_text, '#投稿 #改过了\n\n这是管理员改过的版本');

  // 撤下 → 群里的消息被删，状态变成 recalled，可以重新发布
  const updatedPost = h.fake.messagesTo(TARGET_CHAT).find((m) => m.message_id === post.message_id);
  await h.dispatch(clickButton(h, findButton(updatedPost, '撤下'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  assert.equal(submissions(h)[0].status, 'recalled');
  const recalledIds = h.fake.state.deletions.filter((d) => d.chatId === TARGET_CHAT).map((d) => d.messageId);
  assert.ok(recalledIds.includes(post.message_id));

  const notice = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(notice.text, /已把投稿 #1 从群里撤下/);
  await h.dispatch(clickButton(h, findButton(notice, '重新发布'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  assert.equal(submissions(h)[0].status, 'published');
  assert.ok(
    h.fake.messagesTo(TARGET_CHAT).some((m) => m.text?.includes('这是管理员改过的版本')),
    '重新发布时用改过的文案',
  );
});

test('投稿中途可以上一步和取消', async () => {
  const h = createHarness();

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '文字分享')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));

  // 现在在正文步骤，点「上一步」应回到标题
  let prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /正文/);
  await h.dispatch(clickButton(h, findButton(prompt, '上一步')));
  prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /已回到上一步/);
  assert.match(prompt.text, /标题/);

  // 取消后回到菜单
  await h.dispatch(clickButton(h, findButton(prompt, '取消')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /已取消这次投稿/);
  const session = h.env.DB.raw.prepare('SELECT * FROM sessions WHERE user_id = ?').get(USER_ID);
  assert.equal(session, undefined);

  // 过期按钮：没有会话时点旧按钮，只弹提示、不再发消息
  const messageCount = h.fake.messagesTo(USER_ID).length;
  await h.dispatch(clickButton(h, 'w:opt:category:0'));
  assert.equal(h.fake.messagesTo(USER_ID).length, messageCount, '过期按钮不应再发消息');
  const lastAnswer = h.fake.callsOf('answerCallbackQuery').at(-1);
  assert.match(lastAnswer.text, /过期/);
});

test('General 关闭且机器人没有管理话题权限时，返回明确的修复提示', async () => {
  const targetId = -1001234567890;
  const h = createHarness(
    { TARGET_CHAT_ID: '' },
    {
      failures: {
        sendMessage: (params) =>
          Number(params.chat_id) === targetId && String(params.text).includes('General 权限提示测试')
            ? 'Bad Request: TOPIC_CLOSED'
            : null,
        reopenGeneralForumTopic: (params) =>
          Number(params.chat_id) === targetId ? 'Bad Request: CHAT_ADMIN_REQUIRED' : null,
      },
    },
  );

  await h.dispatch(groupCommand(h, '/bind', { chatId: targetId }));
  const receipt = await submitViaWizard(h, { body: 'General 权限提示测试' });
  assert.match(receipt.text, /发布失败/);
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /管理话题/);
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /Manage Topics/);
});

test('管理员角色管理：owner 可添加/调整/移除管理员，最后 owner 受保护', async () => {
  const h = createHarness();
  const owner = ADMIN_ID;
  const manager = 42424;

  await h.dispatch(groupCommand(h, `/addadmin ${manager} moderator`, { userId: owner }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /已添加 42424 为审核员/);
  await h.dispatch(groupCommand(h, '/admins', { userId: owner }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /42424/);
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /审核员/);

  await h.dispatch(groupCommand(h, `/adminrole ${manager} admin`, { userId: owner }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /调整为管理员/);

  await h.dispatch(groupCommand(h, `/deladmin ${manager}`, { userId: owner }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /已移除管理员 42424/);

  await h.dispatch(groupCommand(h, `/deladmin ${owner}`, { userId: owner }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /来自 ADMIN_IDS 配置/);

  const audit = h.env.DB.raw.prepare('SELECT action, target_id FROM audit_logs ORDER BY id').all();
  assert.ok(audit.some((row) => row.action === 'admin.add' && row.target_id === String(manager)));
  assert.ok(audit.some((row) => row.action === 'admin.role' && row.target_id === String(manager)));
  assert.ok(audit.some((row) => row.action === 'admin.remove' && row.target_id === String(manager)));
});

test('管理员角色权限：moderator 可以审核，但不能修改管理员或运行时配置', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const moderator = 42425;
  await h.dispatch(groupCommand(h, `/addadmin ${moderator} moderator`, { userId: ADMIN_ID }));

  await h.dispatch(groupCommand(h, '/bind', { userId: moderator, chatId: TARGET_CHAT }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /没有修改机器人配置/);

  await h.dispatch(groupCommand(h, `/addadmin 42426 admin`, { userId: moderator }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /只有所有者/);

  await submitViaWizard(h, { body: '审核员应该能处理这条' });
  const review = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('审核员应该能处理这条'));
  await h.dispatch(clickButton(h, findButton(review, '通过'), { userId: moderator, chatId: REVIEW_CHAT }));
  assert.equal(submissions(h)[0].status, 'published');
});

test('用户管理：查询、静音、解除静音、管理员备注，并阻止静音用户提交', async () => {
  const h = createHarness();
  await h.dispatch(privateMessage(h, '/start', { userId: USER_ID }));
  await h.dispatch(groupCommand(h, `/mute ${USER_ID} 60`, { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /静音 60 分钟/);

  await submitViaWizard(h, { body: '静音用户不应该成功提交' });
  assert.match(h.fake.lastMessageTo(USER_ID).text, /投稿暂时被限制/);
  assert.equal(submissions(h).length, 0);

  await h.dispatch(groupCommand(h, `/note ${USER_ID} 这是管理员备注`, { userId: ADMIN_ID }));
  await h.dispatch(groupCommand(h, `/user ${USER_ID}`, { userId: ADMIN_ID }));
  const profile = h.fake.lastMessageTo(TARGET_CHAT).text;
  assert.match(profile, /这是管理员备注/);
  assert.match(profile, /静音至/);

  await h.dispatch(groupCommand(h, `/unmute ${USER_ID}`, { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /解除用户 555 的静音/);
});

test('管理员可查看待审核队列与最近审计记录', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  await submitViaWizard(h, { body: '队列里的第一条' });
  await h.dispatch(groupCommand(h, '/pending', { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  assert.match(h.fake.lastMessageTo(REVIEW_CHAT).text, /队列里的第一条/);

  await h.dispatch(groupCommand(h, `/ban ${USER_ID} 队列测试`, { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  await h.dispatch(groupCommand(h, '/audit', { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  assert.match(h.fake.lastMessageTo(REVIEW_CHAT).text, /user\.ban/);
  assert.match(h.fake.lastMessageTo(REVIEW_CHAT).text, /555/);
});

test('发布目标：Owner 可授权多个群，并在面板独立启停，投稿发布到全部启用目标', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' });
  const targetA = -100111;
  const targetB = -100222;

  await h.dispatch(groupCommand(h, '/bind', { chatId: targetA }));
  await h.dispatch(groupCommand(h, '/bind', { chatId: targetB }));
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM publish_targets').get().n, 2);

  await h.dispatch(privateMessage(h, '/targets', { userId: ADMIN_ID }));
  const panel = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(panel.text, /2\/2 启用/);
  assert.equal((panel.keyboard.inline_keyboard ?? []).flat().length, 4);

  const toggleB = panel.keyboard.inline_keyboard[2][0].callback_data;
  await h.dispatch(clickButton(h, toggleB, { userId: ADMIN_ID, chatId: ADMIN_ID }));
  const disabled = h.env.DB.raw.prepare('SELECT enabled FROM publish_targets WHERE chat_id = ?').get(targetB);
  assert.equal(disabled.enabled, 0);

  const receipt = await submitViaWizard(h, { body: '多目标发布测试' });
  assert.match(receipt.text, /投稿已发布/);
  assert.ok(h.fake.messagesTo(targetA).some((m) => m.text?.includes('多目标发布测试')));
  assert.ok(!h.fake.messagesTo(targetB).some((m) => m.text?.includes('多目标发布测试')));
});

test('发布目标：普通管理员不能授权目标，必须由 Owner /bind', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' });
  const moderator = 42424;
  await h.dispatch(groupCommand(h, '/addadmin 42424 moderator', { userId: ADMIN_ID }));
  await h.dispatch(groupCommand(h, '/bind', { userId: moderator, chatId: -100333 }));
  assert.match(h.fake.lastMessageTo(-100333).text, /只有所有者/);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM publish_targets').get().n, 0);
});

test('发布目标：频道 /bind 需要 Owner 仍是频道管理员，并登记为可发布目标', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' });
  await h.dispatch({
    channel_post: { message_id: 7001, chat: { id: -100444, type: 'channel', title: '测试频道' }, text: '/bind' },
  });
  const target = h.env.DB.raw.prepare('SELECT * FROM publish_targets WHERE chat_id = ?').get(-100444);
  assert.ok(target);
  assert.equal(target.chat_type, 'channel');
  assert.equal(target.enabled, 1);
});

test('webhook：配置了 WEBHOOK_SECRET 后，secret 头缺失或不匹配一律 403', async () => {
  const h = createHarness();
  const update = JSON.stringify({
    update_id: 990001,
    message: {
      message_id: 1,
      from: { id: 1, is_bot: false, first_name: 'x' },
      chat: { id: 1, type: 'private' },
      date: 1,
      text: '/start',
    },
  });

  const missing = await worker.fetch(
    new Request(`https://bot.example/webhook/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: update,
    }),
    h.env,
    h.ctx,
  );
  assert.equal(missing.status, 403, '缺 secret 头不能再放行（伪造 update 的门）');

  const wrong = await worker.fetch(
    new Request(`https://bot.example/webhook/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'nope' },
      body: update,
    }),
    h.env,
    h.ctx,
  );
  assert.equal(wrong.status, 403);

  const ok = await worker.fetch(
    new Request(`https://bot.example/webhook/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: update,
    }),
    h.env,
    h.ctx,
  );
  assert.equal(ok.status, 200, '带正确 secret 头的合法流量不受影响');
  await h.drain();
});

test('webhook：未配置 WEBHOOK_SECRET 时自检必须警告（fail-open 保持可用）', () => {
  const config = loadConfig({ BOT_TOKEN: 'test-token', ADMIN_IDS: '1', TARGET_CHAT_ID: '-1001' });
  const problems = checkConfig(config);
  assert.ok(
    problems.some((item) => item.includes('WEBHOOK_SECRET')),
    `自检必须点名 WEBHOOK_SECRET：${JSON.stringify(problems)}`,
  );
});

test('webhook：/health 深度自检 D1（不可达时 503）', async () => {
  const h = createHarness();
  const ok = await worker.fetch(new Request('https://bot.example/health'), h.env, h.ctx);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.db, 'ok');

  const broken = createHarness();
  broken.env.DB = {
    prepare: () => {
      throw new Error('d1 down');
    },
  };
  const bad = await worker.fetch(new Request('https://bot.example/health'), broken.env, broken.ctx);
  assert.equal(bad.status, 503);
});

test('telegram client：editMessageCaption 通道（caption 卡片硬ening）', async () => {
  const h = createHarness();
  const { Telegram } = await import('../src/telegram.js');
  const tg = new Telegram('test-token', { apiBase: 'http://fake.local', fetchImpl: h.fake.fetch });
  await tg.editMessageCaption(TARGET_CHAT, 42, '<b>新说明</b>', { keyboard: { inline_keyboard: [[]] } });
  const call = h.fake.callsOf('editMessageCaption').at(-1);
  assert.ok(call, 'editMessageCaption 应被调用');
  assert.equal(call.caption, '<b>新说明</b>');
  assert.equal(call.chat_id, TARGET_CHAT);
  assert.equal(call.message_id, 42);
  assert.ok(call.reply_markup, '键盘要跟着走');
});
