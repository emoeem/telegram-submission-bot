/** 测试脚手架：把 Worker 的 fetch 直接跑起来，配合假 Telegram + 内存 D1。 */

import { readFileSync } from 'node:fs';

import worker from '../src/index.js';
import { createD1 } from './d1.js';
import { createFakeTelegram } from './fake-telegram.js';

export const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
export const USER_ID = 555;
export const USER2_ID = 777;
export const ADMIN_ID = 999;
export const TARGET_CHAT = -100777;
export const REVIEW_CHAT = -100888;
export const SECRET = 'secret123';

export function createHarness(envOverrides = {}, fakeOptions = {}) {
  const fake = createFakeTelegram(fakeOptions);
  const env = {
    DB: createD1(SCHEMA),
    BOT_TOKEN: 'test-token',
    WEBHOOK_SECRET: SECRET,
    TELEGRAM_API_BASE: 'http://fake.local',
    // 通过绑定注入假 Telegram，而不是覆盖 globalThis.fetch：
    // 这样同一个进程里可以同时存在多个 harness 而不互相串。
    TELEGRAM_FETCH: fake.fetch,
    TARGET_CHAT_ID: String(TARGET_CHAT),
    MAIN_GROUP_URL: 'https://t.me/+testinvite',
    ADMIN_CHAT_ID: '',
    ADMIN_IDS: String(ADMIN_ID),
    REQUIRE_REVIEW: '0',
    RATE_LIMIT_COUNT: '0',
    ...envOverrides,
  };

  const tasks = [];
  const ctx = {
    waitUntil(promise) {
      tasks.push(promise);
    },
  };

  let updateId = 0;
  let incomingMessageId = 5000;

  const harness = {
    env,
    fake,
    ctx,
    nextIncoming() {
      return ++incomingMessageId;
    },
    async drain() {
      while (tasks.length > 0) {
        const batch = tasks.splice(0, tasks.length);
        await Promise.all(batch);
      }
    },
    async dispatchWith(updateIdValue, update) {
      const request = new Request(`https://bot.example/webhook/${SECRET}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': SECRET,
        },
        body: JSON.stringify({ update_id: updateIdValue, ...update }),
      });
      const response = await worker.fetch(request, harness.env, ctx);
      await harness.drain();
      return response;
    },
    async dispatch(update) {
      updateId += 1;
      return harness.dispatchWith(updateId, update);
    },
    /**
     * 同时派发多条 update（模拟 Telegram 并发投递：相册、连点按钮）。
     * 先把所有 handler 都塞进 waitUntil，再一起 drain，才能真正并发。
     */
    async dispatchTogether(updates) {
      const requests = updates.map((update) => {
        updateId += 1;
        return worker.fetch(
          new Request(`https://bot.example/webhook/${SECRET}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Telegram-Bot-Api-Secret-Token': SECRET,
            },
            body: JSON.stringify({ update_id: updateId, ...update }),
          }),
          harness.env,
          ctx,
        );
      });
      const responses = await Promise.all(requests);
      await harness.drain();
      return responses;
    },
  };

  return harness;
}

export function privateMessage(harness, text, { userId = USER_ID, entities } = {}) {
  return {
    message: {
      message_id: harness.nextIncoming(),
      from: { id: userId, is_bot: false, first_name: '小明', username: 'xiaoming' },
      chat: { id: userId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      entities,
    },
  };
}

export function privatePhoto(harness, fileId, uniqueId, { userId = USER_ID } = {}) {
  return {
    message: {
      message_id: harness.nextIncoming(),
      from: { id: userId, is_bot: false, first_name: '小明', username: 'xiaoming' },
      chat: { id: userId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      photo: [
        { file_id: `${fileId}_small`, file_unique_id: `${uniqueId}_small`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: uniqueId, width: 1280, height: 720 },
      ],
    },
  };
}

export function privateAttachment(harness, kind, fileId, uniqueId, { userId = USER_ID, extra = {} } = {}) {
  const message = {
    message_id: harness.nextIncoming(),
    from: { id: userId, is_bot: false, first_name: '小明', username: 'xiaoming' },
    chat: { id: userId, type: 'private' },
    date: Math.floor(Date.now() / 1000),
  };
  switch (kind) {
    case 'video':
      message.video = { file_id: fileId, file_unique_id: uniqueId, file_name: 'video.mp4', ...extra };
      break;
    case 'document':
      message.document = { file_id: fileId, file_unique_id: uniqueId, file_name: extra.file_name ?? 'doc.pdf' };
      break;
    case 'voice':
      message.voice = { file_id: fileId, file_unique_id: uniqueId };
      break;
    case 'audio':
      message.audio = { file_id: fileId, file_unique_id: uniqueId, title: extra.title ?? 'song' };
      break;
    case 'poll':
      message.poll = {
        id: uniqueId,
        question: extra.question ?? '投票问题？',
        options: (extra.options ?? ['A', 'B']).map((text) => ({ text })),
      };
      break;
    case 'location':
      message.location = { latitude: extra.latitude ?? 31.23, longitude: extra.longitude ?? 121.47 };
      break;
    default:
      throw new Error(`不支持的附件类型：${kind}`);
  }
  return { message };
}

/** 用户回复某条消息（用于双向对话测试）。 */
export function privateReply(harness, repliedMessage, text, { userId = USER_ID } = {}) {
  return {
    message: {
      message_id: harness.nextIncoming(),
      from: { id: userId, is_bot: false, first_name: '小明', username: 'xiaoming' },
      chat: { id: userId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      reply_to_message: {
        message_id: repliedMessage.message_id,
        chat: { id: Number(userId), type: 'private' },
        text: repliedMessage.text,
      },
    },
  };
}

/** 管理员在群里回复某条消息（用于双向对话测试）。 */
export function groupReply(harness, repliedMessage, text, { userId = ADMIN_ID, chatId = TARGET_CHAT } = {}) {
  return {
    message: {
      message_id: harness.nextIncoming(),
      from: { id: userId, is_bot: false, first_name: '管理员', username: 'admin' },
      chat: { id: chatId, type: 'supergroup' },
      date: Math.floor(Date.now() / 1000),
      text,
      reply_to_message: {
        message_id: repliedMessage.message_id,
        chat: { id: Number(chatId), type: 'supergroup' },
        text: repliedMessage.text,
      },
    },
  };
}

/** 模拟点击某个聊天里最近一条机器人消息上的按钮。 */
export function clickButton(harness, callbackData, { userId = USER_ID, chatId = USER_ID } = {}) {
  const message = harness.fake.lastMessageTo(chatId);
  if (!message) throw new Error(`聊天 ${chatId} 里还没有机器人消息`);
  return {
    callback_query: {
      id: `cb-${Math.random().toString(36).slice(2)}`,
      from: { id: userId, is_bot: false, first_name: '管理员', username: 'admin' },
      message: { message_id: message.message_id, chat: { id: Number(chatId), type: 'private' }, text: message.text },
      data: callbackData,
    },
  };
}

export function groupCommand(harness, text, { userId = ADMIN_ID, chatId = TARGET_CHAT, threadId } = {}) {
  return {
    message: {
      message_id: harness.nextIncoming(),
      from: { id: userId, is_bot: false, first_name: '管理员', username: 'admin' },
      chat: { id: chatId, type: 'supergroup' },
      date: Math.floor(Date.now() / 1000),
      text,
      message_thread_id: threadId,
    },
  };
}
