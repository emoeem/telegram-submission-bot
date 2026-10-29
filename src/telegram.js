/** 极简 Telegram Bot API 客户端（基于 fetch，可直接跑在 Worker 里）。 */

import { sleep } from './utils.js';

export class TelegramError extends Error {
  constructor(method, description, errorCode, retryAfter) {
    super(`Telegram ${method} 失败：${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.description = description;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}

export class Telegram {
  constructor(token, { apiBase = 'https://api.telegram.org', fetchImpl } = {}) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/+$/, '');
    // 必须绑定到 globalThis：Workers 里把 fetch 存成属性后再调用会丢 this，
    // 直接报 "Illegal invocation"（Node 和浏览器不会，所以只有线上会炸）。
    const impl = fetchImpl ?? globalThis.fetch;
    this.fetch = typeof impl === 'function' ? impl.bind(globalThis) : impl;
  }

  url(method) {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  /** 调一次 API，对 429 和网络抖动做有限重试。 */
  async call(method, params = {}, { retries = 1 } = {}) {
    const body = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body[key] = typeof value === 'object' ? JSON.stringify(value) : value;
    }
    return this.send(method, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, retries);
  }

  /**
   * 用 multipart/form-data 上传本地文件（网页投稿用）。
   * 不能走 call()：它把所有参数都塞进 JSON，上传必须让 fetch 自己带 boundary。
   */
  callForm(method, formData, { retries = 1 } = {}) {
    return this.send(method, { body: formData }, retries);
  }

  /** 上传一个文件并返回它所在的 Message（file_id 从里面取）。 */
  async uploadFile(method, field, chatId, file, { filename, caption, threadId } = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('disable_notification', 'true');
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    if (threadId) form.append('message_thread_id', String(threadId));
    form.append(field, file, filename ?? (typeof file?.name === 'string' ? file.name : undefined));
    return this.callForm(method, form);
  }

  /** 请求 + 有限重试（call 和 callForm 共用）。 */
  async send(method, init, retries = 1) {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.fetch(this.url(method), { method: 'POST', ...init });
        const payload = await response.json().catch(() => ({}));
        if (payload && payload.ok) return payload.result;

        const errorCode = payload?.error_code ?? response.status;
        const retryAfter = payload?.parameters?.retry_after;
        const description = payload?.description ?? `HTTP ${response.status}`;
        if ((errorCode === 429 || errorCode >= 500) && attempt < retries) {
          attempt += 1;
          await sleep(Math.min((retryAfter ?? 1) * 1000, 3000));
          continue;
        }
        throw new TelegramError(method, description, errorCode, retryAfter);
      } catch (error) {
        if (error instanceof TelegramError) throw error;
        if (attempt < retries) {
          attempt += 1;
          await sleep(500);
          continue;
        }
        throw new TelegramError(method, String(error?.message ?? error), 0);
      }
    }
  }

  // ---------- 消息 ----------

  sendMessage(chatId, text, { keyboard, threadId, replyTo, linkPreview = false } = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: linkPreview ? undefined : { is_disabled: true },
      reply_markup: keyboard,
      message_thread_id: threadId,
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
  }

  sendPhoto(chatId, fileId, { caption, keyboard, threadId } = {}) {
    return this.call('sendPhoto', {
      chat_id: chatId,
      photo: fileId,
      caption,
      parse_mode: caption ? 'HTML' : undefined,
      reply_markup: keyboard,
      message_thread_id: threadId,
    });
  }

  sendVideo(chatId, fileId, { caption, threadId } = {}) {
    return this.call('sendVideo', {
      chat_id: chatId,
      video: fileId,
      caption,
      parse_mode: caption ? 'HTML' : undefined,
      message_thread_id: threadId,
    });
  }

  sendDocument(chatId, fileId, { caption, threadId } = {}) {
    return this.call('sendDocument', {
      chat_id: chatId,
      document: fileId,
      caption,
      parse_mode: caption ? 'HTML' : undefined,
      message_thread_id: threadId,
    });
  }

  sendAudio(chatId, fileId, { caption, threadId } = {}) {
    return this.call('sendAudio', {
      chat_id: chatId,
      audio: fileId,
      caption,
      parse_mode: caption ? 'HTML' : undefined,
      message_thread_id: threadId,
    });
  }

  sendVoice(chatId, fileId, { caption, threadId } = {}) {
    return this.call('sendVoice', {
      chat_id: chatId,
      voice: fileId,
      caption,
      parse_mode: caption ? 'HTML' : undefined,
      message_thread_id: threadId,
    });
  }

  sendPoll(chatId, question, options, { threadId } = {}) {
    return this.call('sendPoll', {
      chat_id: chatId,
      question,
      options: options.map((text) => ({ text })),
      is_anonymous: true,
      message_thread_id: threadId,
    });
  }

  sendLocation(chatId, latitude, longitude, { threadId } = {}) {
    return this.call('sendLocation', {
      chat_id: chatId,
      latitude,
      longitude,
      message_thread_id: threadId,
    });
  }

  /** 发相册：只有图片和视频能成组，第一项带 caption，Telegram 上限 10 项。 */
  sendMediaGroup(chatId, items, { caption, threadId } = {}) {
    const media = items.slice(0, 10).map((item, index) => ({
      type: item.type,
      media: item.media,
      caption: index === 0 ? caption : undefined,
      parse_mode: index === 0 && caption ? 'HTML' : undefined,
    }));
    return this.call('sendMediaGroup', { chat_id: chatId, media, message_thread_id: threadId });
  }

  pinChatMessage(chatId, messageId) {
    return this.call('pinChatMessage', {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  }

  unpinChatMessage(chatId, messageId) {
    return this.call('unpinChatMessage', { chat_id: chatId, message_id: messageId });
  }

  reopenForumTopic(chatId, threadId) {
    return this.call('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId });
  }

  reopenGeneralForumTopic(chatId) {
    return this.call('reopenGeneralForumTopic', { chat_id: chatId });
  }

  editMessageText(chatId, messageId, text, { keyboard, removeKeyboard = false } = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: removeKeyboard ? { inline_keyboard: [] } : keyboard,
    });
  }

  /**
   * 就地替换一条消息的媒体（不删消息，因此保留点赞/评论/置顶）。
   * 注意：只能替换"这一条"的媒体，改不了媒体的个数，所以个数变了还得走删+重发。
   */
  editMessageMedia(chatId, messageId, { type, media }, { caption } = {}) {
    return this.call('editMessageMedia', {
      chat_id: chatId,
      message_id: messageId,
      media: {
        type,
        media,
        caption,
        parse_mode: caption ? 'HTML' : undefined,
      },
    });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(callbackQueryId, { text, showAlert = false } = {}) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert || undefined,
    });
  }

  /** 用表情回执代替"收到啦"，相册连发时不会刷屏。 */
  setMessageReaction(chatId, messageId, emoji) {
    return this.call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    });
  }

  // ---------- 信息 ----------

  getMe() {
    return this.call('getMe');
  }

  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  getChatAdministrators(chatId) {
    return this.call('getChatAdministrators', { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  setWebhook(url, secretToken) {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken || undefined,
      allowed_updates: ['message', 'channel_post', 'callback_query', 'edited_message', 'my_chat_member'],
      drop_pending_updates: true,
    });
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo');
  }

  setMyCommands() {
    return this.call('setMyCommands', {
      commands: [
        { command: 'start', description: '开始投稿' },
        { command: 'cancel', description: '取消当前投稿' },
        { command: 'drafts', description: '我的草稿' },
        { command: 'my', description: '我的投稿记录' },
        { command: 'help', description: '使用说明' },
        { command: 'myid', description: '查看我的 ID' },
        { command: 'admin', description: '管理员面板' },
        { command: 'pending', description: '待审核投稿' },
        { command: 'comments', description: '查看投稿评论' },
        { command: 'stats', description: '投稿统计' },
        { command: 'user', description: '查看用户' },
        { command: 'admins', description: '管理员列表' },
        { command: 'targets', description: '发布目标管理' },
        { command: 'topic', description: '把投稿发到当前话题' },
      ],
    });
  }
}
