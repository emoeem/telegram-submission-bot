/**
 * 回归测试：覆盖审计中确认的 8 个 Bug 与新交互。
 *
 * 重点保证：
 *   「用户上传图片/视频」≠「机器人立即发布」
 *   只有用户明确点「✅ 确认发布」之后才真正发到目标群，并且绝不多发。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import {
  ADMIN_ID,
  REVIEW_CHAT,
  TARGET_CHAT,
  USER2_ID,
  USER_ID,
  clickButton,
  createHarness,
  groupCommand,
  groupReply,
  privateAttachment,
  SCHEMA,
  privateMessage,
  privatePhoto,
} from './harness.js';
import { findButton } from './fake-telegram.js';

/** 构造一个指向指定消息的回调（用于模拟"点旧消息上的旧按钮"）。 */
function callbackFor(data, { userId = USER_ID, chatId = USER_ID, messageId } = {}) {
  return {
    callback_query: {
      id: `cb-${Math.random().toString(36).slice(2)}`,
      from: { id: userId, is_bot: false, first_name: '测试', username: 'tester' },
      message: { message_id: messageId, chat: { id: Number(chatId), type: 'private' }, text: '' },
      data,
    },
  };
}

function sessionRow(h, userId = USER_ID) {
  return h.env.DB.raw.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId);
}

function submissions(h) {
  return h.env.DB.raw.prepare('SELECT id, status FROM submissions ORDER BY id').all();
}

function mediaRows(h, userId = USER_ID) {
  return h.env.DB.raw.prepare('SELECT * FROM session_media WHERE user_id = ? ORDER BY ordinal, id').all(userId);
}

function groupPosts(h, chatId = TARGET_CHAT) {
  return h.fake.messagesTo(chatId).filter((m) => m.text?.includes('#投稿'));
}

/** 只数还没被删掉的群消息（假 Telegram 不会把已删除的消息从记录里移除）。 */
function liveMessages(h, chatId = TARGET_CHAT) {
  const deleted = new Set(h.fake.state.deletions.map((d) => d.messageId));
  return h.fake.messagesTo(chatId).filter((m) => !deleted.has(m.message_id));
}

/** 走到「确认页」为止（不点确认）。 */
async function walkToPreview(h, { body = '正文内容', photos = [], category = '文字分享' } = {}) {
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), category)));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过'))); // 标题
  await h.dispatch(privateMessage(h, body));
  const mediaPrompt = h.fake.lastMessageTo(USER_ID);
  for (const photo of photos) await h.dispatch(privatePhoto(h, photo, `uniq-${photo}`));
  await h.dispatch(clickButton(h, findButton(mediaPrompt, photos.length > 0 ? '就这些了' : '跳过')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '匿名投稿')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过'))); // 联系方式
  return h.fake.lastMessageTo(USER_ID);
}

// ---------------------------------------------------------------------------
// 核心原则：上传 ≠ 发布
// ---------------------------------------------------------------------------

test('确认前绝不发布：上传、预览阶段目标群都必须一条消息都没有', async () => {
  const h = createHarness();

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '图片分享')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));
  await h.dispatch(privateMessage(h, '这条还在草稿阶段'));
  const mediaPrompt = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(privatePhoto(h, 'draft_photo', 'uniq-draft'));

  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0, '上传媒体后不该有任何群消息');

  await h.dispatch(clickButton(h, findButton(mediaPrompt, '就这些了')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '匿名投稿')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));

  const preview = h.fake.lastMessageTo(USER_ID);
  assert.match(preview.text, /请确认投稿内容/);
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0, '确认页也不该发布');
  assert.equal(submissions(h).length, 0, '确认前不该产生投稿记录');

  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  assert.equal(groupPosts(h).length, 1, '点确认之后才发布');
});

test('确认页会真实预览媒体，并展示最终发布文案', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '带两张图的投稿', photos: ['p1', 'p2'] });

  // 私聊里真的收到了这两张图的预览（两张图会组成一个相册预览）
  const previewGroups = h.fake.callsOf('sendMediaGroup').filter((call) => Number(call.chat_id) === USER_ID);
  assert.equal(previewGroups.length, 1, '两张图应该作为一个相册预览到');
  assert.equal(previewGroups[0].media.length, 2);
  assert.ok(
    h.fake.messagesTo(USER_ID).some((m) => m.caption?.includes('这些媒体会随投稿一起发布')),
    '预览相册要有说明 caption',
  );

  // 最终文案也展示出来（不是只有分项列表）
  assert.match(preview.text, /发布后的样子/);
  assert.match(preview.text, /#投稿 #文字分享 #图片/);
  assert.match(preview.text, /带两张图的投稿/);
  // 预览阶段不能出现在群里
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0);
});

test('点确认后先显示「正在发布」，用户不会以为没反应', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '发布过程可见' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  assert.ok(
    h.fake.state.edits.some((edit) => edit.text?.includes('正在发布')),
    '确认页应被改写成「正在发布」',
  );
});

// ---------------------------------------------------------------------------
// Bug 1 / 7：陈旧按钮与确认页状态
// ---------------------------------------------------------------------------

test('陈旧的确认按钮不能发布残缺投稿（Bug 1）', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '原始正文' });
  const oldConfirm = findButton(preview, '确认发布');

  // 进入编辑：会话回到「正文」这一步
  await h.dispatch(clickButton(h, findButton(preview, '✏️ 编辑内容')));
  const menu = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(menu, '正文')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /写正文/);

  // 现在去点那条旧确认页上的按钮
  await h.dispatch(callbackFor(oldConfirm, { messageId: preview.message_id }));

  assert.equal(submissions(h).length, 0, '过期按钮不能产生投稿');
  assert.equal(groupPosts(h).length, 0, '过期按钮不能发布');
  const lastAnswer = h.fake.callsOf('answerCallbackQuery').at(-1);
  assert.match(lastAnswer.text, /过期/);
});

test('确认页上直接打字不会污染内容（Bug 7）', async () => {
  const h = createHarness();
  await walkToPreview(h, { body: '原本的正文' });

  await h.dispatch(privateMessage(h, '我在确认页随手打的一句话'));

  const data = JSON.parse(sessionRow(h).data);
  assert.equal(data.body.plain, '原本的正文', '确认页打字不能改掉正文');
  assert.equal(sessionRow(h).step_id, null, '不能莫名其妙跳回某一步');
  assert.match(h.fake.lastMessageTo(USER_ID).text, /现在是确认页/);
  assert.equal(submissions(h).length, 0);
});

test('首步是文本的模板，确认页打字也不会覆盖（Bug 7 变体）', async () => {
  const template = JSON.stringify({
    default: {
      name: '默认',
      steps: [
        { id: 'body', type: 'text', prompt: '写正文', required: true, label: '正文' },
        { id: 'photos', type: 'media', prompt: '配图？', required: false, label: '图片' },
      ],
    },
  });
  const h = createHarness({ TEMPLATES_JSON: template });
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(privateMessage(h, '原始正文'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /请确认投稿内容/);

  await h.dispatch(privateMessage(h, '确认页乱打'));
  const data = JSON.parse(sessionRow(h).data);
  assert.equal(data.body.plain, '原始正文');
});

// ---------------------------------------------------------------------------
// Bug 6：编辑保留数据
// ---------------------------------------------------------------------------

test('确认页「编辑内容」保留已填内容，改完自动回确认页（Bug 6）', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '要被改掉的正文', photos: ['keep1'] });
  assert.match(preview.text, /要被改掉的正文/);

  await h.dispatch(clickButton(h, findButton(preview, '✏️ 编辑内容')));
  const menu = h.fake.lastMessageTo(USER_ID);
  // 菜单里列出所有步骤，点哪项改哪项
  assert.match(menu.text, /想改哪一项/);
  assert.ok((menu.keyboard.inline_keyboard ?? []).flat().some((b) => b.text.includes('正文')));

  await h.dispatch(clickButton(h, findButton(menu, '正文')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /写正文/);
  await h.dispatch(privateMessage(h, '改好之后的正文'));

  const after = h.fake.lastMessageTo(USER_ID);
  assert.match(after.text, /请确认投稿内容/, '改完应该自动回确认页');
  assert.match(after.text, /改好之后的正文/);
  // 其它内容必须还在
  assert.match(after.text, /图片×1/);
  assert.equal(mediaRows(h).length, 1, '编辑文字不该动到媒体');

  await h.dispatch(clickButton(h, findButton(after, '确认发布')));
  assert.ok(groupPosts(h).some((m) => m.text?.includes('改好之后的正文')));
  assert.ok(!groupPosts(h).some((m) => m.text?.includes('要被改掉的正文')));
});

test('确认页「返回上一步」回到最后一个步骤，也能继续往回走', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '返回测试' });
  await h.dispatch(clickButton(h, findButton(preview, '返回上一步')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /联系方式/, '应回到最后一步');
});

// ---------------------------------------------------------------------------
// Bug 2 / 3 / 4：幂等
// ---------------------------------------------------------------------------

test('并发双击「确认发布」只发布一次（Bug 2）', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '双击测试', photos: ['d1', 'd2'] });
  const confirm = findButton(preview, '确认发布');

  await h.dispatchTogether([
    callbackFor(confirm, { messageId: preview.message_id }),
    callbackFor(confirm, { messageId: preview.message_id }),
  ]);

  assert.equal(submissions(h).length, 1, '只能有一条投稿记录');
  assert.equal(groupPosts(h).length, 1, '群里只能有一条');
  const mediaGroups = h.fake.callsOf('sendMediaGroup').filter((c) => Number(c.chat_id) === TARGET_CHAT);
  assert.equal(mediaGroups.length, 1, '相册也只能发一次');
});

test('发布成功后再点旧确认按钮不会重复发布', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '重试幂等' });
  const confirm = findButton(preview, '确认发布');
  await h.dispatchTogether([
    callbackFor(confirm, { messageId: preview.message_id }),
    callbackFor(confirm, { messageId: preview.message_id }),
  ]);
  const firstCount = groupPosts(h).length;
  assert.equal(submissions(h).length, 1);

  // 再点一次旧确认按钮：不能又发一条
  await h.dispatch(callbackFor(confirm, { messageId: preview.message_id }));
  assert.equal(groupPosts(h).length, firstCount);
  assert.equal(submissions(h).length, 1);
});

test('审核模式「通过」并发连点只发布一次（Bug 3）', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const preview = await walkToPreview(h, { body: '审核连点' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  assert.equal(submissions(h)[0].status, 'pending');

  const reviewPost = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('审核连点'));
  const approve = findButton(reviewPost, '通过');
  await h.dispatchTogether([
    callbackFor(approve, { userId: ADMIN_ID, chatId: REVIEW_CHAT, messageId: reviewPost.message_id }),
    callbackFor(approve, { userId: ADMIN_ID, chatId: REVIEW_CHAT, messageId: reviewPost.message_id }),
  ]);

  assert.equal(groupPosts(h).length, 1, '目标群只能有一条');
  assert.equal(submissions(h)[0].status, 'published');
  const notices = h.fake.messagesTo(USER_ID).filter((m) => m.text?.includes('已通过审核'));
  assert.equal(notices.length, 1, '投稿者只该收到一次通过通知');
});

test('审核模式缺独立审核群时拒绝收稿，绝不把草稿发到公开群（Bug 8）', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: '' });

  await h.dispatch(privateMessage(h, '/start', { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /审核群/);
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0, '公开群不能出现任何东西');

  // 即便有人硬造一个「确认页」会话，submit 也必须拒绝
  const state = { phase: 'preview', nonce: 'deadbeef', editing: false, previewMediaIds: [], submissionId: null };
  h.env.DB.raw
    .prepare(
      `INSERT INTO sessions (user_id, template_id, step_id, data, prompt_chat_id, prompt_message_id, updated_at)
       VALUES (?, 'default', NULL, ?, ?, 4242, ?)`,
    )
    .run(
      USER_ID,
      JSON.stringify({ category: '文字分享', body: { plain: '不该出现' }, author: '匿名投稿', __state: state }),
      USER_ID,
      Math.floor(Date.now() / 1000),
    );

  await h.dispatch(callbackFor('w:confirm', { messageId: 4242 }));
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0, '草稿不能被公开');
  assert.equal(submissions(h).length, 0);
  assert.match(h.fake.lastMessageTo(USER_ID).text, /审核群/);
});

test('撤下后「重新发布」并发连点只发布一次（Bug 4）', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '重发连点' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('重发连点'));

  await h.dispatch(clickButton(h, findButton(post, '撤下'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const notice = h.fake.lastMessageTo(ADMIN_ID);
  const republish = findButton(notice, '重新发布');

  await h.dispatchTogether([
    callbackFor(republish, { userId: ADMIN_ID, chatId: ADMIN_ID, messageId: notice.message_id }),
    callbackFor(republish, { userId: ADMIN_ID, chatId: ADMIN_ID, messageId: notice.message_id }),
  ]);

  const alive = h.fake
    .messagesTo(TARGET_CHAT)
    .filter((m) => m.text?.includes('重发连点') && !h.fake.state.deletions.some((d) => d.messageId === m.message_id));
  assert.equal(alive.length, 1, '重新发布只能留下一条');
});

// ---------------------------------------------------------------------------
// Bug 5：相册并发
// ---------------------------------------------------------------------------

test('相册并发上传不会丢附件（Bug 5）', async () => {
  const h = createHarness();
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '图片分享')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));
  await h.dispatch(privateMessage(h, '并发相册'));
  const mediaPrompt = h.fake.lastMessageTo(USER_ID);

  // Telegram 相册是多条 update 并发投递
  await h.dispatchTogether([1, 2, 3, 4, 5].map((i) => privatePhoto(h, `cp${i}`, `uniq-cp${i}`)));

  const rows = mediaRows(h);
  assert.equal(rows.length, 5, '5 张图必须一张不少');
  assert.deepEqual(
    rows.map((r) => r.ordinal),
    [1, 2, 3, 4, 5],
  );

  await h.dispatch(clickButton(h, findButton(mediaPrompt, '就这些了')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '匿名投稿')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '确认发布')));

  const mediaGroups = h.fake.callsOf('sendMediaGroup').filter((c) => Number(c.chat_id) === TARGET_CHAT);
  assert.equal(mediaGroups[0].media.length, 5, '5 张图应该一起发出去');
});

// ---------------------------------------------------------------------------
// 媒体管理：删除 / 排序 / 重选
// ---------------------------------------------------------------------------

test('媒体管理：删除单个、调整顺序、重新选择全部', async () => {
  const h = createHarness();
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '图片分享')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));
  await h.dispatch(privateMessage(h, '媒体管理测试'));
  const mediaPrompt = h.fake.lastMessageTo(USER_ID);
  for (const id of ['m1', 'm2', 'm3']) await h.dispatch(privatePhoto(h, id, `uniq-${id}`));

  // 打开管理面板
  await h.dispatch(clickButton(h, findButton(mediaPrompt, '管理媒体')));
  let panel = h.fake.lastMessageTo(USER_ID);
  assert.match(panel.text, /管理媒体（共 3 个）/);

  const buttons = (row) => (panel.keyboard.inline_keyboard ?? [])[row];
  // 第 2 项上移 → 顺序变成 m2, m1, m3
  await h.dispatch(clickButton(h, buttons(1)[1].callback_data));
  assert.deepEqual(
    mediaRows(h).map((r) => JSON.parse(r.payload).fileId),
    ['m2', 'm1', 'm3'],
  );
  panel = h.fake.lastMessageTo(USER_ID);

  // 删除第 1 项（m2）
  await h.dispatch(clickButton(h, (panel.keyboard.inline_keyboard ?? [])[0][3].callback_data));
  assert.deepEqual(
    mediaRows(h).map((r) => JSON.parse(r.payload).fileId),
    ['m1', 'm3'],
  );
  panel = h.fake.lastMessageTo(USER_ID);
  assert.match(panel.text, /管理媒体（共 2 个）/);

  // 重新选择全部 → 清空
  await h.dispatch(clickButton(h, findButton(panel, '重新选择全部')));
  assert.equal(mediaRows(h).length, 0);
  assert.match(h.fake.lastMessageTo(USER_ID).text, /管理媒体（共 0 个）/);

  // 返回步骤提示后仍可继续（不会卡死）
  panel = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(panel, '返回')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /配图/);
});

test('媒体管理：从确认页进入，返回时回到确认页', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '从确认页管媒体', photos: ['x1'] });
  await h.dispatch(clickButton(h, findButton(preview, '管理媒体')));
  const panel = h.fake.lastMessageTo(USER_ID);
  assert.match(panel.text, /管理媒体（共 1 个）/);
  await h.dispatch(clickButton(h, findButton(panel, '返回')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /请确认投稿内容/);
});

// ---------------------------------------------------------------------------
// 失败恢复
// ---------------------------------------------------------------------------

test('发布失败后原地重试，不必重新填一遍', async () => {
  let attempts = 0;
  const h = createHarness(
    {},
    {
      failures: {
        sendMessage: (params) => {
          if (Number(params.chat_id) !== TARGET_CHAT || !String(params.text).includes('失败重试测试')) return null;
          attempts += 1;
          return attempts === 1 ? 'Bad Request: not enough rights' : null;
        },
      },
    },
  );

  const preview = await walkToPreview(h, { body: '失败重试测试', photos: ['r1', 'r2'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  const failure = h.fake.lastMessageTo(USER_ID);
  assert.match(failure.text, /发布失败/);
  assert.deepEqual(
    (failure.keyboard.inline_keyboard ?? []).flat().map((b) => b.text),
    ['🔁 重试发布', '✏️ 返回修改', '❌ 取消'],
  );
  assert.equal(submissions(h)[0].status, 'failed');
  assert.equal(sessionRow(h).step_id, null, '草稿要留着才能重试');

  // 媒体已经发出去了，重试只补正文，不能重发相册
  const mediaGroupsBefore = h.fake.callsOf('sendMediaGroup').filter((c) => Number(c.chat_id) === TARGET_CHAT).length;

  await h.dispatch(clickButton(h, findButton(failure, '重试发布')));
  assert.equal(submissions(h).length, 1, '重试不能新建投稿');
  assert.equal(submissions(h)[0].status, 'published');
  assert.equal(
    h.fake.callsOf('sendMediaGroup').filter((c) => Number(c.chat_id) === TARGET_CHAT).length,
    mediaGroupsBefore,
    '重试不该重发相册',
  );
  assert.ok(h.fake.lastMessageTo(USER_ID).text.includes('投稿已发布'));
});

test('失败后点「返回修改」还能改内容再发', async () => {
  let fail = true;
  const h = createHarness(
    {},
    {
      failures: {
        sendMessage: (params) =>
          fail && Number(params.chat_id) === TARGET_CHAT && String(params.text).includes('改完再发')
            ? 'Bad Request: nope'
            : null,
      },
    },
  );
  const preview = await walkToPreview(h, { body: '改完再发' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const failure = h.fake.lastMessageTo(USER_ID);
  assert.match(failure.text, /发布失败/);

  await h.dispatch(clickButton(h, findButton(failure, '返回修改')));
  const menu = h.fake.lastMessageTo(USER_ID);
  assert.match(menu.text, /想改哪一项/);
  await h.dispatch(clickButton(h, findButton(menu, '正文')));
  await h.dispatch(privateMessage(h, '第二次尝试的内容'));
  fail = false;
  const updated = h.fake.lastMessageTo(USER_ID);
  assert.match(updated.text, /把第二次尝试的内容|第二次尝试的内容/);
  await h.dispatch(clickButton(h, findButton(updated, '确认发布')));
  assert.ok(groupPosts(h).some((m) => m.text?.includes('第二次尝试的内容')));
});

// ---------------------------------------------------------------------------
// 评论关联
// ---------------------------------------------------------------------------

test('相册第 2..N 条消息与多目标消息都能关联到投稿', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600' });
  const preview = await walkToPreview(h, { body: '相册关联测试', photos: ['a1', 'a2', 'a3'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  const album = h.fake.messagesTo(TARGET_CHAT).filter((m) => m.photo);
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('相册关联测试'));
  assert.equal(album.length, 3);

  const count = () => h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM discussion_comments').get().n;
  for (const message of [...album, post]) {
    const before = count();
    await h.dispatch(groupReply(h, message, `回复消息 ${message.message_id}`));
    assert.equal(count(), before + 1, `在消息 ${message.message_id} 下回复应该被记成评论`);
    assert.ok(
      h.fake.lastMessageTo(USER_ID).text.includes(`回复消息 ${message.message_id}`),
      '作者的通知里要看得到这条评论',
    );
  }
});

test('撤回时会删掉相册里的每一条消息', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '撤回相册', photos: ['z1', 'z2', 'z3'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const posted = h.fake.messagesTo(TARGET_CHAT).map((m) => m.message_id);
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('撤回相册'));

  await h.dispatch(clickButton(h, findButton(post, '撤下'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const deleted = new Set(h.fake.state.deletions.map((d) => d.messageId));
  for (const id of posted) assert.ok(deleted.has(id), `消息 ${id} 应该被删掉`);
  assert.equal(submissions(h)[0].status, 'recalled');
});

// ---------------------------------------------------------------------------
// 草稿 TTL / 投稿历史 / 取消
// ---------------------------------------------------------------------------

test('草稿超过 TTL 自动作废，不会恢复陈旧内容', async () => {
  const h = createHarness({ SESSION_TTL_SECONDS: '60' });
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '文字分享')));
  assert.ok(sessionRow(h), '应该已经有草稿');

  h.env.DB.raw
    .prepare('UPDATE sessions SET updated_at = ? WHERE user_id = ?')
    .run(Math.floor(Date.now() / 1000) - 120, USER_ID);

  await h.dispatch(privateMessage(h, '很久以前打的字'));
  assert.equal(sessionRow(h), undefined, '过期草稿应被清掉');
  assert.ok(h.fake.messagesTo(USER_ID).some((m) => m.text?.includes('放太久')));
});

test('/my 能查到自己的投稿历史与状态', async () => {
  const h = createHarness();
  await h.dispatch(privateMessage(h, '/my'));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /还没有投过稿/);

  const preview = await walkToPreview(h, { body: '历史记录测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  await h.dispatch(privateMessage(h, '/my'));
  const history = h.fake.lastMessageTo(USER_ID).text;
  assert.match(history, /你最近的投稿/);
  assert.match(history, /#1/);
  assert.match(history, /已发布/);
});

test('取消之后旧按钮全部失效', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '取消后失效' });
  const confirm = findButton(preview, '确认发布');
  await h.dispatch(clickButton(h, findButton(preview, '取消')));
  assert.equal(sessionRow(h), undefined);

  await h.dispatch(callbackFor(confirm, { messageId: preview.message_id }));
  assert.equal(submissions(h).length, 0);
  assert.equal(groupPosts(h).length, 0);
  assert.match(h.fake.callsOf('answerCallbackQuery').at(-1).text, /过期/);
});

test('会话不会串步骤：流程中途点别的步骤按钮会被拒绝', async () => {
  const h = createHarness();
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '文字分享')));
  const titlePrompt = h.fake.lastMessageTo(USER_ID);
  assert.match(titlePrompt.text, /标题/);

  // 现在在「标题」这一步，却去点「分类」那一步的选项（消息是当前那条，但步骤已经过去了）
  await h.dispatch(callbackFor('w:opt:category:3', { messageId: titlePrompt.message_id }));
  assert.match(h.fake.callsOf('answerCallbackQuery').at(-1).text, /过期/);
  assert.equal(JSON.parse(sessionRow(h).data).category, '文字分享', '不能改掉已经选过的分类');
  assert.equal(sessionRow(h).step_id, 'title', '也不能把流程拨回上一步');
});

// ---------------------------------------------------------------------------
// 崩溃恢复与配置安全
// ---------------------------------------------------------------------------

test('发布中途 Worker 崩溃后不会卡死：租约过期即可恢复重试', async () => {
  const h = createHarness();
  await walkToPreview(h, { body: '崩溃恢复测试' });
  const data = JSON.parse(sessionRow(h).data);
  const nonce = data.__state.nonce;
  const now = Math.floor(Date.now() / 1000);

  // 模拟「已经进入发布、但 Worker 挂了」：投稿卡在 publishing，会话停在 publishing，租约已过期
  const created = h.env.DB.raw
    .prepare(
      "INSERT INTO submissions (user_id, template_id, data, status, created_at) VALUES (?, 'default', '{}', 'publishing', ?)",
    )
    .run(USER_ID, now);
  const submissionId = Number(created.lastInsertRowid);
  h.env.DB.raw
    .prepare(
      `INSERT INTO submission_guards (guard_key, submission_id, status, locked_until, created_at, updated_at)
       VALUES (?, ?, 'locked', ?, ?, ?)`,
    )
    .run(`w:${USER_ID}:${nonce}`, submissionId, now - 10, now - 200, now - 200);
  data.__state.phase = 'publishing';
  data.__state.submissionId = submissionId;
  h.env.DB.raw
    .prepare('UPDATE sessions SET data = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify(data), now, USER_ID);

  // 用户回来 /start：应该能重新看到确认页并完成发布，而不是永远卡住
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  const resumed = h.fake.lastMessageTo(USER_ID);
  assert.match(resumed.text, /请确认投稿内容/);
  assert.equal(JSON.parse(sessionRow(h).data).__state.phase, 'preview', '陈旧的 publishing 状态要被降级');
  assert.equal(h.env.DB.raw.prepare('SELECT status FROM submissions WHERE id = ?').get(submissionId).status, 'failed');

  await h.dispatch(clickButton(h, findButton(resumed, '确认发布')));
  assert.equal(groupPosts(h).length, 1, '恢复后应该正好发布一次');
  assert.equal(
    h.env.DB.raw.prepare('SELECT status FROM submissions WHERE id = ?').get(submissionId).status,
    'published',
  );
});

test('配置了独立审核群时 /review on 正常生效', async () => {
  const h = createHarness({ ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  await h.dispatch(groupCommand(h, '/review on'));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /审核模式已开启/);
  await h.dispatch(groupCommand(h, '/settings'));
  const settings = h.fake.lastMessageTo(TARGET_CHAT).text;
  assert.match(settings, new RegExp(String(REVIEW_CHAT)));
  assert.match(settings, /最多附件：10 个/);
});

test('审核群和发布群是同一个时会被拦下（防止草稿泄漏）', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(TARGET_CHAT) });
  await h.dispatch(privateMessage(h, '/start', { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /审核群和发布群是同一个/);
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0);
});

test('确认时被敏感词拦下后，用户手里仍然有可点的按钮（不是死路）', async () => {
  const h = createHarness({ BANNED_WORDS: '违禁词' });
  const preview = await walkToPreview(h, { body: '这条含违禁词' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  const last = h.fake.lastMessageTo(USER_ID);
  assert.match(last.text, /不允许的用词/);
  assert.match(last.text, /请确认投稿内容/, '应该重新给一份带按钮的确认页');
  const labels = (last.keyboard.inline_keyboard ?? []).flat().map((b) => b.text);
  assert.ok(
    labels.some((t) => t.includes('确认发布')),
    '确认按钮必须还在',
  );
  assert.ok(
    labels.some((t) => t.includes('编辑内容')),
    '编辑按钮也必须在',
  );
  assert.equal(submissions(h).length, 0);
  assert.equal(groupPosts(h).length, 0);
});

test('批量通过与手动通过并发时也只发布一次', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const preview = await walkToPreview(h, { body: '批量并发' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const reviewPost = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('批量并发'));
  assert.ok(reviewPost);

  await h.dispatchTogether([
    groupCommand(h, '/approve_all', { userId: ADMIN_ID, chatId: REVIEW_CHAT }),
    callbackFor(findButton(reviewPost, '通过'), {
      userId: ADMIN_ID,
      chatId: REVIEW_CHAT,
      messageId: reviewPost.message_id,
    }),
  ]);

  assert.equal(groupPosts(h).length, 1, '两条通过路径并发也只能发一条');
  assert.equal(submissions(h)[0].status, 'published');
});

test('/my 不会给未发布的投稿暴露审核群链接', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const preview = await walkToPreview(h, { body: '待审核历史' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  await h.dispatch(privateMessage(h, '/my'));
  const history = h.fake.lastMessageTo(USER_ID).text;
  assert.match(history, /待审核/);
  assert.ok(!history.includes('🔗'), '待审的投稿在审核群里，用户看不到，不该给链接');
});

test('多目标全部失败后重试：已发出的媒体不重发，两个目标各补一条正文', async () => {
  const targetA = -100111;
  const targetB = -100222;
  const attempts = new Map();
  const h = createHarness(
    { TARGET_CHAT_ID: '' },
    {
      failures: {
        sendMessage: (params) => {
          const id = Number(params.chat_id);
          if (id !== targetA && id !== targetB) return null;
          if (!String(params.text).includes('多目标重试')) return null;
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          return n === 1 ? 'Bad Request: not enough rights' : null;
        },
      },
    },
  );
  await h.dispatch(groupCommand(h, '/bind', { chatId: targetA }));
  await h.dispatch(groupCommand(h, '/bind', { chatId: targetB }));

  const preview = await walkToPreview(h, { body: '多目标重试', photos: ['mt1', 'mt2'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  assert.equal(submissions(h)[0].status, 'failed');
  const failure = h.fake.lastMessageTo(USER_ID);
  assert.match(failure.text, /发布失败/);
  const mediaGroupsBefore = (id) => h.fake.callsOf('sendMediaGroup').filter((c) => Number(c.chat_id) === id).length;
  const beforeA = mediaGroupsBefore(targetA);
  const beforeB = mediaGroupsBefore(targetB);
  assert.equal(beforeA, 1, '第一次尝试时媒体已经发到 A');
  assert.equal(beforeB, 1, '第一次尝试时媒体已经发到 B');

  await h.dispatch(clickButton(h, findButton(failure, '重试发布')));

  assert.equal(submissions(h).length, 1, '重试不新建投稿');
  assert.equal(submissions(h)[0].status, 'published');
  assert.equal(mediaGroupsBefore(targetA), beforeA, 'A 的相册不能重发');
  assert.equal(mediaGroupsBefore(targetB), beforeB, 'B 的相册不能重发');
  for (const id of [targetA, targetB]) {
    const posts = h.fake.messagesTo(id).filter((m) => m.text?.includes('多目标重试'));
    assert.equal(posts.length, 1, `目标 ${id} 应该正好有一条正文`);
  }
});

test('多目标部分失败时投稿者拿到重试入口，重试只补失败的目标', async () => {
  const targetA = -100111;
  const targetB = -100222;
  let failB = true;
  const h = createHarness(
    { TARGET_CHAT_ID: '' },
    {
      failures: {
        sendMessage: (params) =>
          failB && Number(params.chat_id) === targetB && String(params.text).includes('部分失败提示')
            ? 'Bad Request: chat not found'
            : null,
      },
    },
  );
  await h.dispatch(groupCommand(h, '/bind', { chatId: targetA }));
  await h.dispatch(groupCommand(h, '/bind', { chatId: targetB }));

  const preview = await walkToPreview(h, { body: '部分失败提示' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  const failure = h.fake.lastMessageTo(USER_ID);
  assert.match(failure.text, /部分目标发布失败/);
  assert.ok(
    (failure.keyboard.inline_keyboard ?? []).flat().some((b) => b.text.includes('重试发布')),
    '部分失败也要给用户重试入口',
  );
  assert.equal(submissions(h)[0].status, 'failed');
  assert.ok(
    h.fake.messagesTo(targetA).some((m) => m.text?.includes('部分失败提示')),
    'A 已经发成功',
  );
  assert.ok(!h.fake.messagesTo(targetB).some((m) => m.text?.includes('部分失败提示')));

  failB = false;
  await h.dispatch(clickButton(h, findButton(failure, '重试发布')));
  assert.equal(submissions(h)[0].status, 'published');
  assert.equal(
    h.fake.messagesTo(targetA).filter((m) => m.text?.includes('部分失败提示')).length,
    1,
    '已经成功的 A 不能重复发',
  );
  assert.equal(h.fake.messagesTo(targetB).filter((m) => m.text?.includes('部分失败提示')).length, 1, '重试要把 B 补上');
});

test('自定义模板（媒体步骤 id 不是 photos）也能预览、管理、发布', async () => {
  const template = JSON.stringify({
    default: {
      name: '自定义',
      steps: [
        { id: 'body', type: 'text', prompt: '写正文？', required: true, label: '正文' },
        { id: 'attachments', type: 'media', prompt: '要附件吗？', required: false, label: '附件' },
      ],
    },
  });
  const h = createHarness({ TEMPLATES_JSON: template });
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(privateMessage(h, '自定义正文'));
  const mediaPrompt = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(privatePhoto(h, 'c1', 'uc1'));
  await h.dispatch(clickButton(h, findButton(mediaPrompt, '就这些了')));

  const preview = h.fake.lastMessageTo(USER_ID);
  assert.match(preview.text, /自定义正文/);
  assert.match(preview.text, /附件/);

  await h.dispatch(clickButton(h, findButton(preview, '管理媒体')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /管理媒体（共 1 个）/);
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '返回')));
  const back = h.fake.lastMessageTo(USER_ID);
  assert.match(back.text, /请确认投稿内容/);

  await h.dispatch(clickButton(h, findButton(back, '确认发布')));
  assert.equal(groupPosts(h).length, 1);
  assert.equal(mediaRows(h).length, 0, '发布成功后附件表应该清空');
  const publishedMedia = h.fake.messagesTo(TARGET_CHAT).filter((m) => m.photo);
  assert.equal(publishedMedia.length, 1, '单个附件以 sendPhoto 发出');
  assert.equal(publishedMedia[0].photo, 'c1');
});

// ---------------------------------------------------------------------------
// 对抗性评审发现的缺陷：逐条回归
// ---------------------------------------------------------------------------

/** 模拟"某个发布正在进行"：手工占住投稿级租约。 */
function holdSubmissionLease(h, submissionId, seconds = 60) {
  const now = Math.floor(Date.now() / 1000);
  h.env.DB.raw
    .prepare(
      `INSERT OR REPLACE INTO submission_guards (guard_key, submission_id, status, locked_until, created_at, updated_at)
       VALUES (?, ?, 'locked', ?, ?, ?)`,
    )
    .run(`s:${submissionId}`, submissionId, now + seconds, now, now);
}

test('附件分批发送时中途失败：已发出去的批次不会被重发', async () => {
  let docAttempts = 0;
  const h = createHarness(
    {},
    {
      failures: {
        sendDocument: (params) => {
          if (Number(params.chat_id) !== TARGET_CHAT) return null;
          docAttempts += 1;
          return docAttempts === 1 ? 'Bad Request: file too big' : null;
        },
      },
    },
  );
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '文字分享')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));
  await h.dispatch(privateMessage(h, '分批失败测试'));
  const mediaPrompt = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(privatePhoto(h, 'b1', 'ub1'));
  await h.dispatch(privateAttachment(h, 'document', 'doc1', 'udoc1'));
  await h.dispatch(clickButton(h, findButton(mediaPrompt, '就这些了')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '匿名投稿')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));

  const preview = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  // 照片已经发出去了，文件失败 → 整条记成失败
  const photosAfterFirst = h.fake.messagesTo(TARGET_CHAT).filter((m) => m.photo).length;
  assert.equal(photosAfterFirst, 1, '照片这一批应该已经发出去了');
  assert.equal(submissions(h)[0].status, 'failed');

  const failure = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(failure, '重试发布')));

  assert.equal(submissions(h)[0].status, 'published');
  assert.equal(
    h.fake.messagesTo(TARGET_CHAT).filter((m) => m.photo).length,
    photosAfterFirst,
    '重试不能把已经发出去的照片再发一遍',
  );
  assert.equal(
    h.fake.messagesTo(TARGET_CHAT).filter((m) => m.kind === 'document').length,
    1,
    '失败的文件应该在重试时补上',
  );
});

test('失败后改了内容再发：数据库里的正文必须同步更新', async () => {
  let fail = true;
  const h = createHarness(
    {},
    {
      failures: {
        sendMessage: (params) =>
          fail && Number(params.chat_id) === TARGET_CHAT && String(params.text).includes('旧正文')
            ? 'Bad Request: nope'
            : null,
      },
    },
  );
  const preview = await walkToPreview(h, { body: '旧正文' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const failure = h.fake.lastMessageTo(USER_ID);
  assert.match(failure.text, /发布失败/);

  await h.dispatch(clickButton(h, findButton(failure, '返回修改')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '正文')));
  await h.dispatch(privateMessage(h, '新正文'));
  fail = false;
  const updated = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(updated, '确认发布')));

  const row = h.env.DB.raw.prepare('SELECT data FROM submissions WHERE id = 1').get();
  assert.equal(JSON.parse(row.data).body.plain, '新正文', '数据库必须跟着改成新内容');

  // 撤下后重新发布，用的也应该是新内容
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('新正文'));
  await h.dispatch(clickButton(h, findButton(post, '撤下'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const notice = h.fake.lastMessageTo(ADMIN_ID);
  await h.dispatch(clickButton(h, findButton(notice, '重新发布'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  assert.ok(h.fake.messagesTo(TARGET_CHAT).some((m) => m.text?.includes('新正文')));
  assert.ok(!h.fake.messagesTo(TARGET_CHAT).some((m) => m.text?.includes('旧正文')));
});

test('有人正在发布时，管理员通过/批量通过/拒绝都不会插进来', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const preview = await walkToPreview(h, { body: '并发发布保护' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const submissionId = submissions(h)[0].id;
  assert.equal(submissions(h)[0].status, 'pending');

  // 模拟"用户那边正在发布"：占住投稿级租约
  holdSubmissionLease(h, submissionId);

  const reviewPost = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('并发发布保护'));
  await h.dispatch(
    clickButton(h, findButton(reviewPost, '通过'), {
      userId: ADMIN_ID,
      chatId: REVIEW_CHAT,
    }),
  );
  assert.equal(groupPosts(h).length, 0, '被别人占着租约时不能发布');
  assert.equal(submissions(h)[0].status, 'pending', '状态也不能被改掉');

  await h.dispatch(groupCommand(h, '/approve_all', { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  assert.equal(groupPosts(h).length, 0, '批量通过同样不能插进来');

  await h.dispatch(
    clickButton(h, findButton(reviewPost, '拒绝'), {
      userId: ADMIN_ID,
      chatId: REVIEW_CHAT,
    }),
  );
  assert.equal(submissions(h)[0].status, 'pending', '发布中不能被拒绝');

  // 租约释放后一切恢复正常
  h.env.DB.raw.prepare('UPDATE submission_guards SET locked_until = NULL WHERE guard_key = ?').run(`s:${submissionId}`);
  await h.dispatch(
    clickButton(h, findButton(reviewPost, '通过'), {
      userId: ADMIN_ID,
      chatId: REVIEW_CHAT,
    }),
  );
  assert.equal(groupPosts(h).length, 1);
  assert.equal(submissions(h)[0].status, 'published');
});

test('审核卡片不能用发布目标的 forum topic（否则审核群会收到错误话题）', async () => {
  const forum = -1001234567890;
  const h = createHarness({ TARGET_CHAT_ID: '', ADMIN_CHAT_ID: String(REVIEW_CHAT), REQUIRE_REVIEW: '1' });
  await h.dispatch(groupCommand(h, '/bind', { chatId: forum, threadId: 27 }));
  const preview = await walkToPreview(h, { body: '审核话题测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  const reviewSends = h.fake.state.calls.filter(
    (call) =>
      ['sendMessage', 'sendPhoto', 'sendMediaGroup'].includes(call.method) &&
      Number(call.params.chat_id) === REVIEW_CHAT,
  );
  assert.ok(reviewSends.length > 0, '审核群应该收到卡片');
  for (const call of reviewSends) {
    assert.equal(call.params.message_thread_id, undefined, '审核群不该带上发布目标的 topic');
  }
  // 通过之后，正式发布仍然要带 topic
  const reviewPost = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('审核话题测试'));
  await h.dispatch(clickButton(h, findButton(reviewPost, '通过'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  const posted = h.fake.messagesTo(forum).find((m) => m.text?.includes('审核话题测试'));
  assert.equal(posted.threadId, 27, '正式发布要用绑定的话题');
});

test('正文超长时截断发布，而不是永久失败', async () => {
  const template = JSON.stringify({
    default: {
      name: '长文',
      steps: [{ id: 'body', type: 'text', prompt: '写正文', required: true, max_length: 6000, label: '正文' }],
    },
  });
  const h = createHarness({ TEMPLATES_JSON: template, MAX_TEXT_LENGTH: '6000' });
  const body = '很长的内容'.repeat(1000); // 5000 字

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(privateMessage(h, body));
  const preview = h.fake.lastMessageTo(USER_ID);
  assert.match(preview.text, /请确认投稿内容/);

  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  assert.equal(submissions(h)[0].status, 'published');
  const post = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('#投稿'));
  assert.ok(post, '应该发出去了');
  assert.ok(post.text.length <= 4000, `发布文本要截断到上限内，实际 ${post.text.length}`);
});

test('审核群同时是发布目标时，确认提交会被拦住', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(TARGET_CHAT) });
  const state = { phase: 'preview', nonce: 'feedface', editing: false, previewMediaIds: [], submissionId: null };
  h.env.DB.raw
    .prepare(
      `INSERT INTO sessions (user_id, template_id, step_id, data, prompt_chat_id, prompt_message_id, updated_at)
       VALUES (?, 'default', NULL, ?, ?, 7777, ?)`,
    )
    .run(
      USER_ID,
      JSON.stringify({ category: '文字分享', body: { plain: '不该出现' }, author: '匿名投稿', __state: state }),
      USER_ID,
      Math.floor(Date.now() / 1000),
    );

  await h.dispatch(callbackFor('w:confirm', { messageId: 7777 }));
  assert.equal(h.fake.messagesTo(TARGET_CHAT).length, 0, '公开群不能出现草稿');
  assert.equal(submissions(h).length, 0);
  assert.match(h.fake.lastMessageTo(USER_ID).text, /审核群和发布群是同一个/);
});

test('管理员发布中途崩溃后不会永久卡在"发布中"：租约过期即可重新通过', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const preview = await walkToPreview(h, { body: '管理员崩溃恢复' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const submissionId = submissions(h)[0].id;

  // 模拟：管理员点了通过、Worker 在发布中途挂掉 —— 状态卡在 publishing，租约已过期
  const now = Math.floor(Date.now() / 1000);
  h.env.DB.raw.prepare('UPDATE submissions SET status = ? WHERE id = ?').run('publishing', submissionId);
  h.env.DB.raw
    .prepare(
      `INSERT OR REPLACE INTO submission_guards (guard_key, submission_id, status, locked_until, created_at, updated_at)
       VALUES (?, ?, 'locked', ?, ?, ?)`,
    )
    .run(`s:${submissionId}`, submissionId, now - 10, now - 200, now - 200);

  const reviewPost = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('管理员崩溃恢复'));
  await h.dispatch(clickButton(h, findButton(reviewPost, '通过'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));

  assert.equal(groupPosts(h).length, 1, '租约过期后应该能重新发布');
  assert.equal(submissions(h)[0].status, 'published');
});

test('schema.sql 可重复执行，且不会复活已删除的发布目标', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const name of ['session_media', 'submission_guards', 'drafts', 'draft_media', 'discussion_comments']) {
    assert.ok(tables.includes(name), `新表 ${name} 必须建出来`);
  }
  // discussion_comments 必须带 thread_id（作者回复要能回到正确的 forum 话题）
  const commentCols = db
    .prepare("PRAGMA table_info('discussion_comments')")
    .all()
    .map((c) => c.name);
  assert.ok(commentCols.includes('thread_id'), 'discussion_comments 需要 thread_id 列');

  // 老部署：settings 里留着 target_chat_id，publish_targets 为空 → 应该 bootstrap 一个兼容目标
  db.exec("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('target_chat_id', '-100111', 1)");
  db.exec(SCHEMA);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM publish_targets').get().n,
    1,
    '目标表为空时应该迁移出一个兼容目标',
  );

  // 现在有两个目标，删掉其中一个后再跑 schema.sql：绝不能把它复活
  db.exec(`INSERT OR REPLACE INTO publish_targets
             (chat_id, chat_type, title, username, thread_id, thread_title, enabled, added_by, created_at, updated_at)
           VALUES (-100222, 'supergroup', NULL, NULL, NULL, NULL, 1, 1, 1, 1)`);
  db.exec("UPDATE settings SET value = '-100222' WHERE key = 'target_chat_id'");
  db.exec('DELETE FROM publish_targets WHERE chat_id = -100111');
  db.exec(SCHEMA);

  const ids = db
    .prepare('SELECT chat_id FROM publish_targets ORDER BY chat_id')
    .all()
    .map((r) => r.chat_id);
  assert.deepEqual(ids, [-100222], '重复执行不能复活已删除的发布目标');
});

// ---------------------------------------------------------------------------
// 新功能 C：管理员编辑已发布投稿的媒体
// ---------------------------------------------------------------------------

test('管理员改媒体：2 张变 1 张 → 第 1 条就地替换、多出的那条删掉、正文消息保留', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '改媒体测试', photos: ['old1', 'old2'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  const mediaIds = h.fake
    .messagesTo(TARGET_CHAT)
    .filter((m) => m.photo)
    .map((m) => m.message_id);
  assert.equal(mediaIds.length, 2);

  await h.dispatch(clickButton(h, findButton(post, '编辑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const menu = h.fake.lastMessageTo(ADMIN_ID);
  await h.dispatch(clickButton(h, findButton(menu, '改媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /整体替换/);

  await h.dispatch(privatePhoto(h, 'new1', 'unew1', { userId: ADMIN_ID }));
  const collecting = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(collecting.text, /已收到 1 个附件/);
  await h.dispatch(clickButton(h, findButton(collecting, '就这些了'), { userId: ADMIN_ID, chatId: ADMIN_ID }));

  // 第 1 条就地换成新图（消息 id 不变），多出来的第 2 条删掉
  assert.deepEqual(
    h.fake.state.mediaEdits.map((e) => [e.messageId, e.media]),
    [[mediaIds[0], 'new1']],
  );
  const deleted = new Set(h.fake.state.deletions.map((d) => d.messageId));
  assert.ok(!deleted.has(mediaIds[0]), '就地替换的那条不能删');
  assert.ok(deleted.has(mediaIds[1]), '多出来的那条要删掉');
  assert.ok(!deleted.has(post.message_id), '正文消息必须保留（它的互动也不丢）');

  assert.equal(liveMessages(h).filter((m) => m.photo).length, 1, '群里应该只剩 1 张图');
  assert.equal(liveMessages(h).filter((m) => m.text?.includes('#投稿')).length, 1, '群里只该有一条正文');

  const row = h.env.DB.raw.prepare('SELECT data, status FROM submissions WHERE id = 1').get();
  assert.deepEqual(
    JSON.parse(row.data).photos.map((p) => p.fileId),
    ['new1'],
    '数据库里的媒体要同步',
  );
  assert.equal(row.status, 'published');
});

test('管理员改媒体：1 张变 2 张（变多）只能删旧 + 重发', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '变多测试', photos: ['one'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  const oldId = liveMessages(h)[0].message_id;

  await h.dispatch(clickButton(h, findButton(post, '编辑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '改媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );
  await h.dispatch(privatePhoto(h, 'g1', 'ug1', { userId: ADMIN_ID }));
  await h.dispatch(privatePhoto(h, 'g2', 'ug2', { userId: ADMIN_ID }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '就这些了'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );

  assert.equal(h.fake.state.mediaEdits.length, 0, '变多时不能就地改');
  assert.ok(
    h.fake.state.deletions.some((d) => d.messageId === oldId),
    '应该删掉旧消息',
  );
  assert.equal(liveMessages(h).filter((m) => m.photo).length, 2, '两张新图都要发出去');
});

test('管理员改媒体：「清空并去掉媒体」把投稿变成纯文字', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '清空媒体测试', photos: ['only1'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  await h.dispatch(clickButton(h, findButton(post, '编辑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '改媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );
  const collecting = h.fake.lastMessageTo(ADMIN_ID);
  await h.dispatch(clickButton(h, findButton(collecting, '清空并去掉媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }));

  assert.equal(liveMessages(h).filter((m) => m.photo).length, 0, '不该还有媒体');
  const row = h.env.DB.raw.prepare('SELECT data FROM submissions WHERE id = 1').get();
  assert.deepEqual(JSON.parse(row.data).photos, []);
  assert.equal(liveMessages(h).filter((m) => m.text?.includes('#投稿')).length, 1);
});

test('管理员改媒体：一个附件都没发就点「就这些了」不会误伤', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '空媒体测试', photos: ['keepme'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  const before = h.fake.messagesTo(TARGET_CHAT).map((m) => m.message_id);

  await h.dispatch(clickButton(h, findButton(post, '编辑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '改媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );
  const collecting = h.fake.lastMessageTo(ADMIN_ID);
  await h.dispatch(clickButton(h, findButton(collecting, '就这些了'), { userId: ADMIN_ID, chatId: ADMIN_ID }));

  assert.equal(
    liveMessages(h)
      .map((m) => m.message_id)
      .join(','),
    before.join(','),
    '群里的消息不该被动过',
  );
  assert.ok(liveMessages(h).some((m) => m.photo === 'keepme'));
});

test('管理员改媒体：审核中的投稿会被重新送审', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const preview = await walkToPreview(h, { body: '送审改媒体', photos: ['r1'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const reviewPost = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('送审改媒体'));
  const oldReviewIds = h.fake.messagesTo(REVIEW_CHAT).map((m) => m.message_id);

  await h.dispatch(clickButton(h, findButton(reviewPost, '编辑'), { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '改媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );
  await h.dispatch(privatePhoto(h, 'r2', 'ur2', { userId: ADMIN_ID }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '就这些了'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );

  assert.equal(liveMessages(h, TARGET_CHAT).length, 0, '还没审核通过，不能出现在公开群');
  const deleted = new Set(h.fake.state.deletions.map((d) => d.messageId));
  for (const id of oldReviewIds) assert.ok(deleted.has(id), '旧审核卡片要被替换');
  const newCard = h.fake.messagesTo(REVIEW_CHAT).find((m) => m.text?.includes('送审改媒体'));
  assert.ok(newCard, '应该重新送审');
  assert.equal(submissions(h)[0].status, 'pending');
});

// ---------------------------------------------------------------------------
// 新功能 A：Telegram 官方评论区
// ---------------------------------------------------------------------------

/** 构造一条"回复了某条消息"的群消息（可带频道转发来源）。 */
function replyInGroup(
  h,
  { chatId, replyTo, text, userId = USER2_ID, name = '路人', forwardOrigin = null, threadId = null },
) {
  const replied = { message_id: replyTo, chat: { id: chatId, type: 'supergroup' }, text: '…' };
  if (forwardOrigin) replied.forward_origin = forwardOrigin;
  return {
    message: {
      message_id: h.nextIncoming(),
      from: { id: userId, is_bot: false, first_name: name, username: 'passerby' },
      chat: { id: chatId, type: 'supergroup' },
      date: Math.floor(Date.now() / 1000),
      text,
      message_thread_id: threadId ?? undefined,
      reply_to_message: replied,
    },
  };
}

test('官方评论区：路人回复群里的投稿 → 作者收到私聊通知，评论被记录', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '评论区测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '写得不错！' }));

  const notice = h.fake.lastMessageTo(USER_ID);
  assert.match(notice.text, /收到 1 条新评论/);
  assert.match(notice.text, /路人/);
  assert.match(notice.text, /写得不错！/);
  assert.ok(
    (notice.keyboard.inline_keyboard ?? []).flat().some((b) => b.text.includes('写得不错')),
    '通知里要有带评论内容的回复入口',
  );

  const comments = h.env.DB.raw.prepare('SELECT * FROM discussion_comments').all();
  assert.equal(comments.length, 1);
  assert.equal(comments[0].submission_id, 1);
  assert.equal(comments[0].text, '写得不错！');
});

test('官方评论区：作者点「回复这条评论」→ 匿名发回评论区', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '评论回复功能测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  const commentUpdate = replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '请问还有名额吗' });
  await h.dispatch(commentUpdate);
  const comment = commentUpdate.message;

  const notice = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(notice, '请问还有名额吗')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /匿名替你发到评论区/);
  await h.dispatch(privateMessage(h, '还有名额，欢迎来'));

  const reply = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('作者回复：'));
  assert.ok(reply, '作者的回复要出现在评论区');
  assert.match(reply.text, /还有名额，欢迎来/);
  assert.equal(reply.reply_to, comment.message_id, '要挂在原评论下面');
  assert.match(h.fake.lastMessageTo(USER_ID).text, /已发到评论区/);
});

test('官方评论区：频道帖在讨论组的评论（forward_origin）也能关联回投稿', async () => {
  const h = createHarness({ TARGET_CHAT_ID: '' });
  const CHANNEL = -100444;
  const DISCUSSION = -100555;
  await h.dispatch({
    channel_post: { message_id: 7001, chat: { id: CHANNEL, type: 'channel', title: '测试频道' }, text: '/bind' },
  });
  const preview = await walkToPreview(h, { body: '频道讨论区测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const channelPost = h.fake.messagesTo(CHANNEL).find((m) => m.text?.includes('#投稿'));
  assert.ok(channelPost, '应该发到频道');

  await h.dispatch(
    replyInGroup(h, {
      chatId: DISCUSSION,
      replyTo: 9001,
      text: '从讨论组来的评论',
      forwardOrigin: {
        type: 'channel',
        chat: { id: CHANNEL, type: 'channel', title: '测试频道' },
        message_id: channelPost.message_id,
      },
    }),
  );

  const notice = h.fake.lastMessageTo(USER_ID);
  assert.match(notice.text, /从讨论组来的评论/);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM discussion_comments').get().n, 1);
});

test('官方评论区：管理员在群里回复投稿 = 公开评论（不再被偷偷删掉）', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600' });
  const preview = await walkToPreview(h, { body: '管理员也走评论' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  const update = replyInGroup(h, {
    chatId: TARGET_CHAT,
    replyTo: post.message_id,
    text: '管理员的话',
    userId: ADMIN_ID,
    name: '管理员',
  });
  await h.dispatch(update);

  assert.equal(
    h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM discussion_comments').get().n,
    1,
    '管理员的话也是公开评论',
  );
  assert.match(h.fake.lastMessageTo(USER_ID).text, /管理员的话/, '作者同样会收到通知');
  assert.ok(
    !h.fake.state.deletions.some((d) => d.messageId === update.message.message_id),
    '管理员在群里的公开评论不能被机器人删掉',
  );

  // 想私下沟通仍然可以：用帖子上的「回复投稿者」按钮
  await h.dispatch(clickButton(h, findButton(post, '回复投稿者'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(privateMessage(h, '这是私下说的', { userId: ADMIN_ID }));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /管理员回复：\n这是私下说的/);
});

test('/comments 能列出某条投稿收到的评论', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '评论查询测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '查得到我吗' }));

  await h.dispatch(groupCommand(h, '/comments 1', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const listing = h.fake.lastMessageTo(TARGET_CHAT).text;
  assert.match(listing, /查得到我吗/);
  assert.match(listing, /路人/);

  await h.dispatch(groupCommand(h, '/comments', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /用法：\/comments/);
});

// ---------------------------------------------------------------------------
// 新功能 B：多草稿
// ---------------------------------------------------------------------------

/** 起一份有内容的草稿，停在"配图"步骤。 */
async function startDraftWithBody(h, body) {
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, 'w:start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '文字分享')));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '跳过')));
  await h.dispatch(privateMessage(h, body));
  return h.fake.lastMessageTo(USER_ID);
}

test('多草稿：新建投稿会把当前草稿存起来，而不是销毁', async () => {
  const h = createHarness();
  await startDraftWithBody(h, '第一份草稿的正文');

  await h.dispatch(privateMessage(h, '/start'));
  const menu = h.fake.lastMessageTo(USER_ID);
  assert.ok(findButton(menu, '继续投稿'), '有草稿时应该能继续');
  assert.ok(findButton(menu, '新建投稿'), '有草稿时应该能新建');

  await h.dispatch(clickButton(h, findButton(menu, '新建投稿')));
  assert.ok(
    h.fake.messagesTo(USER_ID).some((m) => m.text?.includes('已经存进')),
    '应该告诉用户草稿已保存',
  );
  assert.match(h.fake.lastMessageTo(USER_ID).text, /这次投稿属于哪一类/, '新投稿从第一步开始');
  const drafts = h.env.DB.raw.prepare('SELECT * FROM drafts').all();
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /第一份草稿/);
  assert.equal(
    JSON.parse(h.env.DB.raw.prepare('SELECT data FROM sessions WHERE user_id = ?').get(USER_ID).data).body,
    undefined,
    '当前会话应该是全新的',
  );
});

test('多草稿：/drafts 列表、继续编辑、删除', async () => {
  const h = createHarness();
  await startDraftWithBody(h, '待恢复的正文');
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '新建投稿')));

  await h.dispatch(privateMessage(h, '/drafts'));
  let list = h.fake.lastMessageTo(USER_ID);
  assert.match(list.text, /我的草稿/);
  assert.match(list.text, /待恢复的正文/);

  // 继续编辑：内容回来，草稿被取走
  await h.dispatch(clickButton(h, findButton(list, '继续编辑')));
  const resumed = h.fake.lastMessageTo(USER_ID);
  assert.match(resumed.text, /已恢复这份草稿/);
  const data = JSON.parse(h.env.DB.raw.prepare('SELECT data FROM sessions WHERE user_id = ?').get(USER_ID).data);
  assert.equal(data.body.plain, '待恢复的正文');
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);

  // 再挂起一份然后删掉
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '新建投稿')));
  await h.dispatch(privateMessage(h, '/drafts'));
  list = h.fake.lastMessageTo(USER_ID);
  assert.match(list.text, /待恢复的正文/);
  await h.dispatch(clickButton(h, findButton(list, '删除')));
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);
  assert.match(h.fake.lastMessageTo(USER_ID).text, /还没有挂起的草稿/);
});

test('多草稿：挂起草稿时上传的图片会一起保存并恢复', async () => {
  const h = createHarness();
  await startDraftWithBody(h, '带图的草稿');
  await h.dispatch(privatePhoto(h, 'draftpic', 'udraftpic'));
  assert.equal(mediaRows(h).length, 1);

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '新建投稿')));
  assert.equal(mediaRows(h).length, 0, '当前会话的媒体应该被清空');
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM draft_media').get().n, 1, '媒体应该存进草稿');

  await h.dispatch(privateMessage(h, '/drafts'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '继续编辑')));
  assert.equal(mediaRows(h).length, 1, '恢复草稿要把媒体一起带回来');
  assert.equal(JSON.parse(mediaRows(h)[0].payload).fileId, 'draftpic');
});

test('多草稿：超过上限时最旧的被自动清理', async () => {
  const h = createHarness({ MAX_DRAFTS: '2' });
  const park = async (body) => {
    await startDraftWithBody(h, body);
    await h.dispatch(privateMessage(h, '/start'));
    await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '新建投稿')));
  };
  await park('草稿A');
  await park('草稿B');
  await park('草稿C');

  const titles = h.env.DB.raw
    .prepare('SELECT title FROM drafts ORDER BY id')
    .all()
    .map((r) => r.title);
  assert.equal(titles.length, 2);
  assert.ok(!titles.some((t) => t.includes('草稿A')), '最旧的草稿应该被清掉');
});

test('多草稿：点「取消」是丢弃，不会留下草稿', async () => {
  const h = createHarness();
  const prompt = await startDraftWithBody(h, '这份会被丢掉');
  await h.dispatch(clickButton(h, findButton(prompt, '取消')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /已取消这次投稿/);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('多草稿：清理最旧草稿时会明确告知用户，不静默丢', async () => {
  const h = createHarness({ MAX_DRAFTS: '1' });
  await startDraftWithBody(h, '第一份');
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '新建投稿')));

  await startDraftWithBody(h, '第二份');
  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '新建投稿')));

  const messages = h.fake.messagesTo(USER_ID).map((m) => m.text ?? '');
  assert.ok(
    messages.some((t) => t.includes('草稿最多保留')),
    '丢掉旧草稿时要给出提示',
  );
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 1);
});

// ---------------------------------------------------------------------------
// 评论通知聚合 + 逐条回复
// ---------------------------------------------------------------------------

test('评论通知聚合：窗口内的多条评论只产生一条私聊消息，每条一个回复按钮', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600', COMMENT_NOTIFY_MAX: '5' });
  const preview = await walkToPreview(h, { body: '聚合测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  const before = h.fake.messagesTo(USER_ID).length;
  for (const text of ['第一条', '第二条', '第三条']) {
    await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text }));
  }

  const added = h.fake.messagesTo(USER_ID).slice(before);
  assert.equal(added.length, 1, '窗口内的 3 条评论只该发 1 条私聊（其余是编辑进去的）');
  const notice = h.fake.lastMessageTo(USER_ID);
  assert.match(notice.text, /收到 3 条新评论/);
  assert.match(notice.text, /第一条/);
  assert.match(notice.text, /第三条/);
  const replyButtons = (notice.keyboard.inline_keyboard ?? []).flat().filter((b) => b.text.startsWith('↩️'));
  assert.equal(replyButtons.length, 3, '每条评论对应一个回复按钮');
});

test('评论通知聚合：超过单条上限时会说明只列了最新几条', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600', COMMENT_NOTIFY_MAX: '2' });
  const preview = await walkToPreview(h, { body: '上限测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  for (const text of ['A', 'B', 'C']) {
    await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text }));
  }
  const notice = h.fake.lastMessageTo(USER_ID);
  assert.match(notice.text, /收到 3 条新评论/);
  assert.match(notice.text, /只列了最新 2 条/);
  assert.equal((notice.keyboard.inline_keyboard ?? []).flat().filter((b) => b.text.startsWith('↩️')).length, 2);
});

test('逐条回复评论：点第 1 条的按钮就回在第 1 条下面', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600' });
  const preview = await walkToPreview(h, { body: '逐条回复测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  const first = replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '第一条评论' });
  await h.dispatch(first);
  const second = replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '第二条评论' });
  await h.dispatch(second);

  const notice = h.fake.lastMessageTo(USER_ID);
  const buttons = (notice.keyboard.inline_keyboard ?? []).flat();
  const replyToFirst = buttons.find((b) => b.text.includes('第一条评论'));
  await h.dispatch(clickButton(h, replyToFirst.callback_data, { userId: USER_ID, chatId: USER_ID }));
  await h.dispatch(privateMessage(h, '回给第一条'));

  const posted = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('回给第一条'));
  assert.ok(posted, '作者的回复应该发出去');
  assert.equal(posted.reply_to, first.message.message_id, '要挂在第 1 条评论下面，而不是最新的那条');
});

// ---------------------------------------------------------------------------
// 改媒体：能就地替换就不删消息
// ---------------------------------------------------------------------------

test('改媒体：条数与类型不变时就地替换，消息 id 不变（点赞/评论/置顶都保住）', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '就地替换测试', photos: ['p1', 'p2'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  const beforeIds = liveMessages(h).map((m) => m.message_id);

  await h.dispatch(clickButton(h, findButton(post, '编辑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '改媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );
  await h.dispatch(privatePhoto(h, 'n1', 'un1', { userId: ADMIN_ID }));
  await h.dispatch(privatePhoto(h, 'n2', 'un2', { userId: ADMIN_ID }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '就这些了'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );

  assert.equal(h.fake.state.mediaEdits.length, 2, '两条媒体都该就地替换');
  assert.deepEqual(
    h.fake.state.mediaEdits.map((e) => e.media),
    ['n1', 'n2'],
  );
  assert.equal(
    h.fake.state.deletions.filter((d) => beforeIds.includes(d.messageId)).length,
    0,
    '就地替换不该删任何消息',
  );
  assert.deepEqual(
    liveMessages(h).map((m) => m.message_id),
    beforeIds,
    '消息 id 不变，链接和互动都保住',
  );
  const row = h.env.DB.raw.prepare('SELECT data, status FROM submissions WHERE id = 1').get();
  assert.deepEqual(
    JSON.parse(row.data).photos.map((p) => p.fileId),
    ['n1', 'n2'],
  );
  assert.equal(row.status, 'published');
});

test('改媒体：条数变了没法就地改，回退成删旧消息 + 重发', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '条数变化测试', photos: ['only'] });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  const oldId = liveMessages(h)[0].message_id;

  await h.dispatch(clickButton(h, findButton(post, '编辑'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '改媒体'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );
  await h.dispatch(privatePhoto(h, 'a1', 'ua1', { userId: ADMIN_ID }));
  await h.dispatch(privatePhoto(h, 'a2', 'ua2', { userId: ADMIN_ID }));
  await h.dispatch(
    clickButton(h, findButton(h.fake.lastMessageTo(ADMIN_ID), '就这些了'), { userId: ADMIN_ID, chatId: ADMIN_ID }),
  );

  assert.equal(h.fake.state.mediaEdits.length, 0, '条数变了不能就地改');
  assert.ok(
    h.fake.state.deletions.some((d) => d.messageId === oldId),
    '应该删掉旧消息',
  );
  assert.equal(liveMessages(h).filter((m) => m.photo).length, 2, '两条新图都要发出去');
});

// ---------------------------------------------------------------------------
// 批量通过不再限制 20 条 / 多模板新建投稿
// ---------------------------------------------------------------------------

test('/approve_all 一次能通过超过 20 条', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  for (let index = 0; index < 22; index += 1) {
    const preview = await walkToPreview(h, { body: `批量投稿 ${index}` });
    await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  }
  assert.equal(h.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'").get().n, 22);

  await h.dispatch(groupCommand(h, '/approve_all', { userId: ADMIN_ID, chatId: REVIEW_CHAT }));
  const result = h.fake.lastMessageTo(REVIEW_CHAT).text;
  assert.match(result, /已通过 22 条/, `实际回复：${result}`);
  assert.equal(h.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'published'").get().n, 22);
});

test('多模板：有草稿时也能「新建投稿」，先选类型', async () => {
  const templates = JSON.stringify({
    art: { name: '图文投稿', steps: [{ id: 'body', type: 'text', prompt: '写正文', required: true, label: '正文' }] },
    ask: {
      name: '求助提问',
      steps: [{ id: 'body', type: 'text', prompt: '你的问题？', required: true, label: '问题' }],
    },
  });
  const h = createHarness({ TEMPLATES_JSON: templates });

  await h.dispatch(privateMessage(h, '/start'));
  const startMenu = h.fake.lastMessageTo(USER_ID);
  assert.ok(findButton(startMenu, '图文投稿'), '没有草稿时直接列模板');
  await h.dispatch(clickButton(h, findButton(startMenu, '图文投稿')));
  await h.dispatch(privateMessage(h, '写了一半的内容'));

  await h.dispatch(privateMessage(h, '/start'));
  const menu = h.fake.lastMessageTo(USER_ID);
  assert.ok(findButton(menu, '继续投稿'));
  assert.ok(findButton(menu, '新建投稿'), '多模板时也要有新建投稿');

  await h.dispatch(clickButton(h, findButton(menu, '新建投稿')));
  const picker = h.fake.lastMessageTo(USER_ID);
  assert.match(picker.text, /想写哪种投稿/);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 1, '当前这份先被挂起');

  await h.dispatch(clickButton(h, findButton(picker, '求助提问')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /你的问题？/, '应该用新选的模板开一份新投稿');
});

test('多模板：选类型时点「回到刚才那份」会恢复被挂起的草稿', async () => {
  const templates = JSON.stringify({
    art: { name: '图文投稿', steps: [{ id: 'body', type: 'text', prompt: '写正文', required: true, label: '正文' }] },
    ask: {
      name: '求助提问',
      steps: [{ id: 'body', type: 'text', prompt: '你的问题？', required: true, label: '问题' }],
    },
  });
  const h = createHarness({ TEMPLATES_JSON: templates });

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '图文投稿')));
  await h.dispatch(privateMessage(h, '本来写了一半'));

  await h.dispatch(privateMessage(h, '/start'));
  await h.dispatch(clickButton(h, findButton(h.fake.lastMessageTo(USER_ID), '新建投稿')));
  const picker = h.fake.lastMessageTo(USER_ID);
  assert.match(picker.text, /想写哪种投稿/);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 1);

  await h.dispatch(clickButton(h, findButton(picker, '回到刚才那份')));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /已恢复这份草稿/);
  assert.equal(h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0, '草稿被取回');
  const data = JSON.parse(h.env.DB.raw.prepare('SELECT data FROM sessions WHERE user_id = ?').get(USER_ID).data);
  assert.equal(data.body.plain, '本来写了一半', '内容原样回来');
});

test('评论列表分页：/comments 能翻到更早的，也能翻回来', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '0' });
  const preview = await walkToPreview(h, { body: '分页测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  for (let index = 1; index <= 12; index += 1) {
    await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: `评论${index}` }));
  }

  await h.dispatch(groupCommand(h, '/comments 1', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const first = h.fake.lastMessageTo(TARGET_CHAT);
  assert.match(first.text, /第 1-10 条 \/ 共 12 条/);
  assert.match(first.text, /评论12/);
  const older = findButton(first, '更早');
  await h.dispatch(clickButton(h, older, { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const second = h.fake.lastMessageTo(TARGET_CHAT);
  assert.match(second.text, /第 11-12 条 \/ 共 12 条/);
  assert.match(second.text, /评论1\b/);
  assert.ok(findButton(second, '更新'), '第二页要有"更新"按钮');
});

// ---------------------------------------------------------------------------
// 评论区自检 / 作者评论收件箱 / 按钮化管理面板
// ---------------------------------------------------------------------------

test('/diag：机器人不是讨论组管理员时给出明确警告和修复办法', async () => {
  const h = createHarness({}, { linkedChatId: -100999, botMemberStatus: 'member' });
  await h.dispatch(groupCommand(h, '/diag', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const text = h.fake.lastMessageTo(TARGET_CHAT).text;
  assert.match(text, /评论区自检/);
  assert.match(text, /-100999/);
  assert.match(text, /不是管理员/, '要说清隐私模式会拦掉评论');
  assert.match(text, /setprivacy/, '要给出可执行的修复办法');
});

test('/diag：机器人是讨论组管理员时报告一切正常', async () => {
  const h = createHarness({}, { linkedChatId: -100999, botMemberStatus: 'administrator' });
  await h.dispatch(groupCommand(h, '/diag', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const text = h.fake.lastMessageTo(TARGET_CHAT).text;
  assert.match(text, /所有评论都能收到/);
});

test('/diag：普通群会说明"回复投稿"默认就能收到，并给出自测入口', async () => {
  const h = createHarness();
  await h.dispatch(groupCommand(h, '/diag', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const text = h.fake.lastMessageTo(TARGET_CHAT).text;
  assert.match(text, /普通群/);
  assert.ok(
    (h.fake.lastMessageTo(TARGET_CHAT).keyboard.inline_keyboard ?? []).flat().some((b) => b.text.includes('测一测')),
    '要带自测按钮',
  );
});

test('/diag：频道没有关联讨论组时会明确指出"没人能评论"', async () => {
  const h = createHarness({}, { chatType: 'channel' });
  await h.dispatch(groupCommand(h, '/diag', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const text = h.fake.lastMessageTo(TARGET_CHAT).text;
  assert.match(text, /频道/);
  assert.match(text, /没有任何人能评论/, '这才是"只有管理员能评论"的真正原因');
  assert.match(text, /Discussions/, '要给出关联讨论组的路径');
});

test('评论区自测：布置后群里有人说话就会私聊回报结果', async () => {
  const h = createHarness();
  await h.dispatch(groupCommand(h, '/diag', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const diag = h.fake.lastMessageTo(TARGET_CHAT);
  await h.dispatch(clickButton(h, findButton(diag, '测一测'), { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /已就绪/);

  // 注意：harness 的 groupCommand 固定把名字写成「管理员」，这里手写一条带名字的群消息
  await h.dispatch({
    message: {
      message_id: h.nextIncoming(),
      from: { id: USER2_ID, is_bot: false, first_name: '路人', username: 'passerby' },
      chat: { id: TARGET_CHAT, type: 'supergroup' },
      date: Math.floor(Date.now() / 1000),
      text: '随便说一句',
    },
  });
  const report = h.fake.lastMessageTo(ADMIN_ID).text;
  assert.match(report, /测试通过/);
  assert.match(report, /路人/);
  assert.equal(
    h.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'diag_watch:%'").get().n,
    0,
    '测试是一次性的',
  );
});

test('作者能从通知里查看全部评论，并逐条回复（提示里带被回复的内容）', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600' });
  const preview = await walkToPreview(h, { body: '收件箱测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '第一条评论' }));
  await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '第二条评论' }));

  const notice = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(notice, '全部评论')));
  const inbox = h.fake.lastMessageTo(USER_ID);
  assert.match(inbox.text, /投稿 #1 的评论/);
  assert.match(inbox.text, /第 1-2 条 \/ 共 2 条/);
  assert.match(inbox.text, /第一条评论/);
  assert.match(inbox.text, /第二条评论/);

  await h.dispatch(clickButton(h, findButton(inbox, '第一条评论')));
  const prompt = h.fake.lastMessageTo(USER_ID);
  assert.match(prompt.text, /你要回复/, '回复前要显示你在回哪一条');
  assert.match(prompt.text, /第一条评论/);

  await h.dispatch(privateMessage(h, '回给第一条'));
  const posted = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('回给第一条'));
  assert.ok(posted, '作者的回复要发到评论区');
});

test('别人的投稿不能在私聊里查看评论', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600' });
  const preview = await walkToPreview(h, { body: '越权测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '随便评一句' }));
  await h.dispatch(callbackFor('w:clist:1:0', { userId: USER2_ID, chatId: USER2_ID }));
  assert.equal(h.fake.messagesTo(USER2_ID).length, 1, '只该收到一条「不属于你」');
  assert.match(h.fake.lastMessageTo(USER2_ID).text, /不属于你/);
});

test('管理面板：按钮化，待审队列里可以直接预览并通过', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const preview = await walkToPreview(h, { body: '面板通过测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  await h.dispatch(privateMessage(h, '/admin', { userId: ADMIN_ID }));
  const panel = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(panel.text, /管理面板/);
  const labels = (panel.keyboard.inline_keyboard ?? []).flat().map((b) => b.text);
  assert.ok(
    labels.some((t) => t.includes('待审')),
    '面板要有待审入口',
  );
  assert.ok(
    labels.some((t) => t.includes('评论区自检')),
    '面板要有自检入口',
  );

  await h.dispatch(clickButton(h, findButton(panel, '待审'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  const queue = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(queue.text, /待审核队列（共 1 条）/);
  const previewButton = (queue.keyboard.inline_keyboard ?? []).flat().find((b) => b.callback_data.startsWith('a:pv:'));
  assert.ok(previewButton, '队列里每条要有预览按钮');

  await h.dispatch(clickButton(h, previewButton.callback_data, { userId: ADMIN_ID, chatId: ADMIN_ID }));
  const card = h.fake.lastMessageTo(ADMIN_ID);
  assert.match(card.text, /面板通过测试/, '预览卡片要有完整内容');
  const cardLabels = (card.keyboard.inline_keyboard ?? []).flat().map((b) => b.text);
  assert.ok(cardLabels.some((t) => t.includes('通过')));
  assert.ok(cardLabels.some((t) => t.includes('返回队列')));

  await h.dispatch(clickButton(h, findButton(card, '通过'), { userId: ADMIN_ID, chatId: ADMIN_ID }));
  assert.equal(groupPosts(h).length, 1, '从面板直接通过要真的发布');
  assert.equal(submissions(h)[0].status, 'published');
});

test('管理面板：审核员能看待审，但看不到 Owner 专属项', async () => {
  const h = createHarness({ REQUIRE_REVIEW: '1', ADMIN_CHAT_ID: String(REVIEW_CHAT) });
  const moderator = 42425;
  await h.dispatch(groupCommand(h, `/addadmin ${moderator} moderator`, { userId: ADMIN_ID }));

  await h.dispatch(privateMessage(h, '/admin', { userId: moderator }));
  const panel = h.fake.lastMessageTo(moderator);
  assert.ok((panel.keyboard.inline_keyboard ?? []).flat().some((b) => b.text.includes('待审')));
  const targetsButton = (panel.keyboard.inline_keyboard ?? []).flat().find((b) => b.text.includes('发布目标'));
  await h.dispatch(clickButton(h, targetsButton.callback_data, { userId: moderator, chatId: moderator }));
  assert.match(h.fake.callsOf('answerCallbackQuery').at(-1).text ?? '', /只有所有者/);
});

test('管理员能从评论列表里回复某条公开评论', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600' });
  const preview = await walkToPreview(h, { body: '管理员回复评论' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];
  const commentUpdate = replyInGroup(h, {
    chatId: TARGET_CHAT,
    replyTo: post.message_id,
    text: '这条有问题吧',
    userId: USER2_ID,
  });
  await h.dispatch(commentUpdate);

  await h.dispatch(groupCommand(h, '/comments 1', { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  const list = h.fake.lastMessageTo(TARGET_CHAT);
  const replyButton = (list.keyboard.inline_keyboard ?? []).flat().find((b) => b.callback_data.startsWith('a:crc:'));
  assert.ok(replyButton, '评论列表里要有「回复」按钮');

  await h.dispatch(clickButton(h, replyButton.callback_data, { userId: ADMIN_ID, chatId: TARGET_CHAT }));
  assert.match(h.fake.lastMessageTo(ADMIN_ID).text, /管理员回复/);
  await h.dispatch(privateMessage(h, '已处理，谢谢反馈', { userId: ADMIN_ID }));

  const posted = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('管理员回复：'));
  assert.ok(posted, '管理员的回复要发到评论区');
  assert.equal(posted.reply_to, commentUpdate.message.message_id, '要挂在被回复的那条评论下面');
});

// ---------------------------------------------------------------------------
// 公开评论入口（深链）：任何人点一下就能评论，不依赖群消息推送
// ---------------------------------------------------------------------------

test('普通用户点投稿上的「💬 评论」→ 私聊写内容 → 公开发到投稿下面', async () => {
  const h = createHarness({ COMMENT_NOTIFY_COOLDOWN_SECONDS: '600' });
  const preview = await walkToPreview(h, { body: '深链评论测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  const commentButton = (post.keyboard.inline_keyboard ?? []).flat().find((b) => b.text.includes('评论'));
  assert.ok(commentButton?.url, '投稿上要有公开评论入口');
  const payload = /start=(c_\d+)/.exec(commentButton.url)[1];

  // 普通用户从深链进入私聊
  await h.dispatch(privateMessage(h, `/start ${payload}`, { userId: USER2_ID }));
  const prompt = h.fake.lastMessageTo(USER2_ID);
  assert.match(prompt.text, /写下你的评论/);
  assert.match(prompt.text, /深链评论测试/, '要让他看清在评论哪条投稿');

  await h.dispatch(privateMessage(h, '这张图我喜欢', { userId: USER2_ID }));
  assert.match(h.fake.lastMessageTo(USER2_ID).text, /评论已发出/);

  // 群里的投稿下面出现公开评论，并挂在原投稿下
  const posted = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('这张图我喜欢'));
  assert.ok(posted, '评论要发到群里');
  assert.match(posted.text, /小明：这张图我喜欢/);
  assert.equal(posted.reply_to, post.message_id, '评论要挂在投稿下面');

  // 评论入库 + 作者收到通知
  const row = h.env.DB.raw.prepare('SELECT * FROM discussion_comments').get();
  assert.equal(row.submission_id, 1);
  assert.equal(row.text, '这张图我喜欢');
  assert.match(h.fake.lastMessageTo(USER_ID).text, /这张图我喜欢/, '作者要收到通知');

  // 作者能从通知里的「全部评论」收件箱看到它
  const notice = h.fake
    .messagesTo(USER_ID)
    .find((m) => (m.keyboard?.inline_keyboard ?? []).flat().some((b) => b.text.includes('全部评论')));
  assert.ok(notice, '作者的通知里要有「全部评论」入口');
  await h.dispatch(clickButton(h, findButton(notice, '全部评论'), { userId: USER_ID, chatId: USER_ID }));
  assert.match(h.fake.lastMessageTo(USER_ID).text, /这张图我喜欢/);
});

test('普通用户点管理员按钮不再是一句冷冰冰的拒绝，而是告诉他怎么评论', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '按钮指引测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  const recall = (post.keyboard.inline_keyboard ?? []).flat().find((b) => b.text.includes('撤下'));
  await h.dispatch(clickButton(h, recall.callback_data, { userId: USER2_ID, chatId: TARGET_CHAT }));
  const toast = h.fake.callsOf('answerCallbackQuery').at(-1);
  assert.match(toast.text, /这是管理员操作/);
  assert.match(toast.text, /💬 评论/, '要告诉他正确入口');
});

test('深链评论也有保护：空内容、超长、投稿已删都有提示', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '边界测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));

  await h.dispatch(privateMessage(h, '/start c_999', { userId: USER2_ID }));
  assert.match(h.fake.lastMessageTo(USER2_ID).text, /已经不在群里/, '投稿不存在要有提示');

  await h.dispatch(privateMessage(h, '/start c_1', { userId: USER2_ID }));
  await h.dispatch(privatePhoto(h, 'x', 'ux', { userId: USER2_ID }));
  assert.match(h.fake.lastMessageTo(USER2_ID).text, /需要用文字回答/);

  await h.dispatch(privateMessage(h, 'x'.repeat(801), { userId: USER2_ID }));
  assert.match(h.fake.lastMessageTo(USER2_ID).text, /评论太长了/);
});

// ---------------------------------------------------------------------------
// 评论的评论（嵌套回复）
// ---------------------------------------------------------------------------

test('评论的评论：回复某条评论会记下回复关系，并在通知里写清谁回复谁', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '嵌套评论测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  const firstUpdate = replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '第一层评论' });
  await h.dispatch(firstUpdate);

  await h.dispatch(
    replyInGroup(h, {
      chatId: TARGET_CHAT,
      replyTo: firstUpdate.message.message_id,
      text: '回复第一层',
      userId: 424242,
      name: '路人乙',
    }),
  );

  const rows = h.env.DB.raw.prepare('SELECT * FROM discussion_comments ORDER BY message_id').all();
  assert.equal(rows.length, 2);
  const nested = rows.find((row) => row.text === '回复第一层');
  assert.equal(nested.submission_id, 1, '回复评论也要接回同一条投稿');
  assert.equal(nested.parent_message_id, firstUpdate.message.message_id, '要记下回复的是哪条评论');
  assert.equal(nested.parent_author_name, '路人');

  const notice = h.fake.lastMessageTo(USER_ID);
  assert.match(notice.text, /收到 2 条新评论/, '窗口内的两条评论聚合成一条通知');
  assert.match(notice.text, /↩️ 路人乙 回复 路人：回复第一层/, '通知里要写清是谁回复了谁');

  // 作者点回复按钮：回复的是那条嵌套评论
  await h.dispatch(clickButton(h, findButton(notice, '回复第一层')));
  await h.dispatch(privateMessage(h, '收到，谢谢补充'));
  const reply = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('收到，谢谢补充'));
  assert.equal(reply.reply_to, nested.message_id, '作者回复要挂在嵌套评论下面');
});

test('评论的评论：别人回复「作者回复」时同样能接回投稿', async () => {
  const h = createHarness();
  const preview = await walkToPreview(h, { body: '作者回复接续测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '求问出处' }));
  const notice = h.fake.lastMessageTo(USER_ID);
  await h.dispatch(clickButton(h, findButton(notice, '求问出处')));
  await h.dispatch(privateMessage(h, '出自某本书'));

  const authorReply = h.fake.messagesTo(TARGET_CHAT).find((m) => m.text?.includes('作者回复：'));
  assert.ok(authorReply, '作者的匿名回复要出现在评论区');

  await h.dispatch(
    replyInGroup(h, {
      chatId: TARGET_CHAT,
      replyTo: authorReply.message_id,
      text: '谢谢作者',
      userId: 424242,
      name: '路人乙',
    }),
  );

  const rows = h.env.DB.raw.prepare('SELECT * FROM discussion_comments ORDER BY message_id').all();
  const follow = rows.find((row) => row.text === '谢谢作者');
  assert.ok(follow, '回复「作者回复」也要被记下来');
  assert.equal(follow.submission_id, 1, '要接回同一条投稿');
  assert.equal(follow.parent_author_name, '作者');
  // 窗口内的通知是"编辑进同一条消息"，所以不能只看最后一条
  const noticeAfter = h.fake.messagesTo(USER_ID).find((m) => m.text?.includes('新评论') && m.text.includes('谢谢作者'));
  assert.ok(noticeAfter, '作者要继续收到通知');
});

test('老库没跑评论迁移时：评论照记不崩，/diag 提示去执行 ALTER', async () => {
  const h = createHarness();
  // 模拟线上还没执行 ALTER 的旧库
  h.env.DB.raw.exec('ALTER TABLE discussion_comments DROP COLUMN parent_message_id');
  h.env.DB.raw.exec('ALTER TABLE discussion_comments DROP COLUMN parent_author_name');
  h.env.DB.raw.exec('ALTER TABLE discussion_comments DROP COLUMN kind');

  const preview = await walkToPreview(h, { body: '旧库兼容测试' });
  await h.dispatch(clickButton(h, findButton(preview, '确认发布')));
  const post = groupPosts(h)[0];

  await h.dispatch(replyInGroup(h, { chatId: TARGET_CHAT, replyTo: post.message_id, text: '旧库里的评论' }));
  const row = h.env.DB.raw.prepare('SELECT * FROM discussion_comments').get();
  assert.equal(row.text, '旧库里的评论', '缺字段时也要把评论老老实实记下来');
  assert.match(h.fake.lastMessageTo(USER_ID).text, /旧库里的评论/, '作者照样收到通知');

  await h.dispatch(groupCommand(h, '/diag', { chatId: TARGET_CHAT }));
  assert.match(h.fake.lastMessageTo(TARGET_CHAT).text, /缺「评论回复」字段/, '/diag 要提示管理员去跑迁移');
});
