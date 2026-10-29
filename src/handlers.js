/** 机器人主逻辑：私聊投稿流程 + 群内管理操作。 */

import {
  adminKeyboard,
  adminMediaKeyboard,
  captchaKeyboard,
  adminPanelKeyboard,
  commentAdminKeyboard,
  commentsPanelKeyboard,
  commentInboxKeyboard,
  commentUserKeyboard,
  draftsKeyboard,
  editActionKeyboard,
  editMenuKeyboard,
  mainMenuKeyboard,
  mediaManagerKeyboard,
  pendingQueueKeyboard,
  previewKeyboard,
  rejectReasonsKeyboard,
  republishKeyboard,
  retryKeyboard,
  singleButtonKeyboard,
  stepKeyboard,
  threadAdminKeyboard,
  threadUserKeyboard,
  templateChoiceKeyboard,
  publishTargetsKeyboard,
  publishTargetDeleteKeyboard,
} from './keyboards.js';
import { attachmentsOf, authorDisplayName, composeSubmission, mediaCaption, reviewNotes } from './render.js';
import {
  chunk,
  escapeHtml,
  fingerprint,
  fitHtml,
  fullName,
  linkForMessage,
  nowSeconds,
  randomNonce,
  renderEntities,
  truncate,
} from './utils.js';
import { checkConfig } from './config.js';
import {
  findStep,
  firstStep,
  nextStep,
  previewLines,
  previousStep,
  promptText,
  stepTitle,
  textOf,
  validateAnswer,
  visibleSteps,
} from './wizard.js';

const CAPTCHA_STEP = '__captcha';
const CAPTCHA_EMOJIS = ['🐱', '🐶', '🐼', '🐰', '🦊', '🐸', '🍎', '⚽', '🌻', '🚀'];
const CAPTCHA_MAX_TRIES = 3;
const LINK_PATTERN = /(https?:\/\/|www\.|t\.me\/)\S*/i;
const MAX_MEDIA_GROUP = 10;
/** 发布中租约：Worker 崩溃/超时后，超过这个时间允许用户重试。 */
const PUBLISH_LOCK_SECONDS = 120;
/** Telegram 单条消息上限 4096，确认页留出安全余量。 */
const PREVIEW_BUDGET = 3800;
/** 正式发布时的兜底上限（正文 4096 / 媒体 caption 1024）。 */
const MAX_PUBLISH_TEXT = 4000;
const MAX_CAPTION = 1000;
/** 可以在私聊里真实预览的媒体类型（投票/位置不适合重发，只用文字列出）。 */
const PREVIEWABLE = new Set(['photo', 'video', 'document', 'audio', 'voice']);
/** 管理员"改媒体"时，新媒体先按这个前缀暂存在 session_media 里。 */
const EDIT_MEDIA_PREFIX = '__edit:';

/* 后台审核要能看见图，但浏览器不能直接拿 Telegram 的 file_id：那需要 BOT_TOKEN，
 * 一旦下发到前端等于把整个机器人交出去。所以由服务端换一次 getFile 再自己下载。
 * 这条上限是给代理端点兜底的 —— Worker 内存有限，几百 MB 的文件流进来直接崩。 */
export const MAX_WEB_MEDIA_BYTES = 20 * 1024 * 1024;

/* 只按白名单给 Content-Type。不信任 file_path 的后缀直接拼：网页投稿的上传通道
 * 是公开的，传一个 .svg 进来，同源内联渲染就是 stored XSS，而这条接口挂的正是
 * 后台自己的域名。认不出的扩展名一律退成 application/octet-stream。 */
const MEDIA_CONTENT_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
]);

/** 取 file_path 的扩展名（含点、小写）。没有就是空串。 */
function extensionOf(filePath) {
  const match = /(\.[A-Za-z0-9]{1,8})$/.exec(String(filePath ?? ''));
  return match ? match[1].toLowerCase() : '';
}

function mediaContentType(filePath) {
  return MEDIA_CONTENT_TYPES.get(extensionOf(filePath)) ?? 'application/octet-stream';
}

function editMediaKey(submissionId) {
  return `${EDIT_MEDIA_PREFIX}${submissionId}`;
}

/** Telegram 在目标话题被关闭时抛的错误，用来决定要不要走话题回退。 */
function isTopicClosedError(error) {
  return /TOPIC_CLOSED/i.test(String(error?.message ?? error));
}

/** 评论列表里的显示名：它回复的是别人的评论时加个 ↩️ 提示。 */
function commentDisplayName(row) {
  const name = row.author_name || String(row.author_id ?? '有人');
  return row.parent_author_name ? `↩️ ${name}` : name;
}

function shuffle(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

/** 把一条 Telegram 消息里的可见内容抽成附件描述。 */
function extractAttachment(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const best = message.photo[message.photo.length - 1];
    return { kind: 'photo', fileId: best.file_id, uniqueId: best.file_unique_id };
  }
  if (message.video) {
    return {
      kind: 'video',
      fileId: message.video.file_id,
      uniqueId: message.video.file_unique_id,
      name: message.video.file_name,
    };
  }
  if (message.document) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      uniqueId: message.document.file_unique_id,
      name: message.document.file_name,
    };
  }
  if (message.audio) {
    return {
      kind: 'audio',
      fileId: message.audio.file_id,
      uniqueId: message.audio.file_unique_id,
      name: message.audio.title ?? message.audio.file_name,
    };
  }
  if (message.voice) {
    return { kind: 'voice', fileId: message.voice.file_id, uniqueId: message.voice.file_unique_id };
  }
  if (message.location) {
    const { latitude, longitude } = message.location;
    return { kind: 'location', latitude, longitude, uniqueId: `loc:${latitude},${longitude}` };
  }
  if (message.poll) {
    return {
      kind: 'poll',
      uniqueId: `poll:${message.poll.id}`,
      poll: {
        question: message.poll.question,
        options: (message.poll.options ?? []).map((option) => option.text),
      },
    };
  }
  return null;
}

export class Bot {
  constructor({ config, store, telegram, logger = console }) {
    this.config = config;
    this.store = store;
    this.tg = telegram;
    this.logger = logger;
    this.texts = config.texts;
    this.chatUsernames = new Map(); // 懒加载的群 username，用于生成 t.me 链接
  }

  // ------------------------------------------------------------------
  // 管理员身份与权限：环境变量 ADMIN_IDS 永远是 owner；其余管理员由 D1 管理。
  // ------------------------------------------------------------------

  async adminRole(userId) {
    if (this.config.admins.includes(userId)) return 'owner';
    const row = await this.store.getAdmin(userId);
    return row?.role ?? null;
  }

  async isAdmin(userId) {
    return (await this.adminRole(userId)) !== null;
  }

  async canManageAdmins(userId) {
    return (await this.adminRole(userId)) === 'owner';
  }

  async canModerate(userId) {
    return ['owner', 'admin', 'moderator'].includes(await this.adminRole(userId));
  }

  async ensureAdminBootstrap() {
    await this.store.seedAdmins(this.config.admins);
  }

  adminRoleLabel(role) {
    return { owner: '所有者', admin: '管理员', moderator: '审核员' }[role] ?? role ?? '未知';
  }

  // ------------------------------------------------------------------
  // 运行时设置：数据库里的值优先于部署时的环境变量，
  // 所以管理员在群里改设置不需要重新部署。
  // ------------------------------------------------------------------

  async effectiveTargetChatId() {
    const targets = await this.store.listPublishTargets({ enabledOnly: true });
    if (targets.length > 0) return targets[0].chat_id;
    const stored = await this.store.getSetting('target_chat_id');
    if (stored !== null) {
      const value = Number.parseInt(stored, 10);
      if (Number.isFinite(value)) return value;
    }
    return this.config.targetChatId;
  }

  async effectivePublishTargets() {
    const targets = await this.store.listPublishTargets({ enabledOnly: true });
    if (targets.length > 0) return targets;
    const chatId = await this.effectiveTargetChatId();
    if (chatId === null || chatId === undefined) return [];
    return [
      {
        id: null,
        chat_id: chatId,
        chat_type: 'legacy',
        title: null,
        username: null,
        thread_id: await this.effectiveThreadId(),
      },
    ];
  }

  async isReviewMode() {
    const stored = await this.store.getSetting('require_review');
    if (stored === '1') return true;
    if (stored === '0') return false;
    return this.config.options.requireReview;
  }

  /** 论坛群（话题群）里发布到哪个话题：以 /bind 时所在的话题为准。 */
  async effectiveThreadId() {
    const targets = await this.store.listPublishTargets({ enabledOnly: true });
    if (targets.length > 0) return targets[0].thread_id ?? null;
    const stored = await this.store.getSetting('target_thread_id');
    if (stored !== null) {
      const value = Number.parseInt(stored, 10);
      return Number.isFinite(value) ? value : null;
    }
    return this.config.topicId ?? null;
  }

  /** 审核群必须独立于公开目标群，否则未审核的草稿会直接被人看到。 */
  async effectiveReviewChatId() {
    return this.config.adminChatId ?? null;
  }

  async currentProblems() {
    const targetChatId = await this.effectiveTargetChatId();
    const requireReview = await this.isReviewMode();
    return checkConfig({
      ...this.config,
      targetChatId,
      reviewChatId: await this.effectiveReviewChatId(),
      options: { ...this.config.options, requireReview },
    });
  }

  /** 配置没填全时给用户一句人话；管理员额外看到缺什么。 */
  async replyNotConfigured(chatId, userId, problems) {
    if (this.config.admins.includes(userId)) {
      const lines = problems.map((problem) => `• ${problem}`).join('\n');
      await this.reply(
        chatId,
        `⚙️ 机器人还没配置完成：\n\n${lines}\n\n最快的方式：把我拉进要发布的群，然后在群里发 /bind`,
      );
      return;
    }
    await this.reply(chatId, '⚙️ 机器人还在配置中，稍后再试吧。');
  }

  /** 取一次目标群的 @username，用来拼可点击的投稿链接（失败就退回 /c/ 形式）。 */
  async ensureTargetChat() {
    const chatId = await this.effectiveTargetChatId();
    if (chatId === null || chatId === undefined) return null;
    if (this.chatUsernames.has(chatId)) return this.chatUsernames.get(chatId);
    let username = null;
    try {
      const chat = await this.tg.getChat(chatId);
      username = chat?.username ?? null;
    } catch (error) {
      this.logger.warn?.(`获取群信息失败：${error?.message ?? error}`);
    }
    this.chatUsernames.set(chatId, username);
    return username;
  }

  // ------------------------------------------------------------------
  // 会话：状态机 + 媒体水合 + TTL
  // ------------------------------------------------------------------

  /** 会话元数据统一放在 data.__state：phase / nonce / editing / 预览消息 id。 */
  sessionState(session) {
    if (!session.data || typeof session.data !== 'object') session.data = {};
    if (!session.data.__state || typeof session.data.__state !== 'object') session.data.__state = {};
    return session.data.__state;
  }

  /** 读取会话，顺手做过期清理；过期时给用户一句人话。 */
  async loadSession(userId, { chatId = null } = {}) {
    const session = await this.store.getSession(userId);
    if (!session) return null;
    const ttl = this.config.options.sessionTtlSeconds;
    if (ttl > 0 && session.updatedAt && session.updatedAt < nowSeconds() - ttl) {
      await this.finishSession(userId);
      if (chatId) await this.tryReply(chatId, this.texts('sessionExpired'), { raw: true });
      return null;
    }

    // 上次发布中途 Worker 挂了：租约一过期就把状态降级，别让用户卡在「正在发布」出不来
    const state = session.data?.__state;
    if (state?.phase === 'publishing' && state.nonce) {
      const guard = await this.store.getGuard(`w:${session.userId}:${state.nonce}`);
      const locked = Boolean(guard?.locked_until && guard.locked_until >= nowSeconds());
      if (!locked) {
        state.phase = 'failed';
        state.lastError = state.lastError ?? this.texts('interrupted');
        // 投稿记录也从 publishing 降级，避免永远卡在"发布中"而在 /pending 里隐身
        if (state.submissionId) {
          await this.store.casSubmissionStatus(state.submissionId, ['publishing'], 'failed');
        }
        await this.persistSession(session);
      }
    }
    return session;
  }

  /** 附件存在 session_media 表；加载时水合回 data[mediaStep]，原有渲染逻辑不用改。 */
  async hydrateSessionMedia(session) {
    const template = this.config.templates[session.templateId];
    if (!template) return session;
    const rows = await this.store.listSessionMedia(session.userId);
    const byStep = new Map();
    for (const item of rows) {
      if (!byStep.has(item.stepId)) byStep.set(item.stepId, []);
      byStep.get(item.stepId).push(item);
    }
    for (const step of template.steps) {
      if (step.type !== 'media') continue;
      session.data[step.id] = byStep.get(step.id) ?? [];
    }
    return session;
  }

  /** 写回会话：媒体步骤不进 JSON（它们有自己的表），避免再被整行覆盖。 */
  async persistSession(session) {
    const template = this.config.templates[session.templateId];
    const data = { ...session.data };
    if (template) {
      for (const step of template.steps) if (step.type === 'media') delete data[step.id];
    }
    await this.store.saveSession({ ...session, data });
  }

  /** 交给 submissions 的纯内容（去掉内部元数据，保留媒体）。 */
  submissionData(session) {
    const data = { ...session.data };
    delete data.__state;
    delete data.__captcha;
    return data;
  }

  /** 会话结束：清掉进度和附件。 */
  async finishSession(userId) {
    await this.store.clearSession(userId);
    await this.store.clearSessionMedia(userId);
  }

  /** 模板里的第一个媒体步骤 id。 */
  defaultMediaStep(template) {
    return template?.steps?.find((step) => step.type === 'media')?.id ?? null;
  }

  /** 机器人自己的身份（评论区自检要 id，公开评论按钮要 username）。 */
  async ensureBot() {
    if (this.botInfo) return this.botInfo;
    try {
      const me = await this.tg.getMe();
      this.botInfo = { id: me?.id ?? null, username: me?.username ?? null };
    } catch (error) {
      this.logger.warn?.(`getMe 失败：${error?.message ?? error}`);
      this.botInfo = { id: null, username: null };
    }
    return this.botInfo;
  }

  async ensureBotId() {
    return (await this.ensureBot()).id;
  }

  /**
   * 公开评论入口的深链：任何人在群里点「💬 评论」都会先跳到与机器人的私聊，
   * 在私聊里写内容再发到评论区 —— 这样完全不依赖"机器人能不能收到群消息"。
   */
  async publicCommentUrl(submissionId) {
    const { username } = await this.ensureBot();
    if (!username) return null;
    return `https://t.me/${username}?start=c_${submissionId}`;
  }

  /** 用户点了投稿上的「💬 评论」深链后，让他在私聊里写评论。 */
  async startPublicComment(chatId, from, submissionId) {
    if (await this.store.isBanned(from.id)) return this.reply(chatId, this.texts('banned'));
    const submission = await this.store.getSubmission(submissionId);
    if (!submission || !submission.publishChatId) return this.reply(chatId, this.texts('publicCommentGone'));
    await this.store.setAdminAction(from.id, `public_comment:${submission.id}`, submission.id);
    return this.reply(
      chatId,
      this.texts('publicCommentPrompt', {
        name: escapeHtml(fullName(from) || '你'),
        title: escapeHtml(truncate(textOf(submission.data?.body) || textOf(submission.data?.title) || '这条投稿', 40)),
      }),
      { raw: true },
    );
  }

  /** 把私聊里写好的评论公开发到投稿下面（并记进评论表，作者/管理员都能看到）。 */
  async postPublicComment(submissionId, message, from, chatId) {
    const text = (message.text ?? message.caption ?? '').trim();
    if (!text) {
      await this.tryReply(chatId, this.texts('stepTextExpected'));
      return true;
    }
    if (text.length > 800) {
      await this.tryReply(chatId, this.texts('publicCommentTooLong', { max: 800 }));
      return true;
    }
    const submission = await this.store.getSubmission(submissionId);
    const target = submission?.publishChatId ?? null;
    const anchor = submission?.publishMessageId ?? submission?.mediaMessageId ?? null;
    if (!submission || !target || !anchor) {
      await this.store.clearAdminAction(from.id);
      await this.tryReply(chatId, this.texts('publicCommentGone'));
      return true;
    }
    const name = fullName(from) || '匿名';
    const body = this.texts('publicComment', { name: escapeHtml(name), text: escapeHtml(text) });
    // 锚点可能在话题里：评论必须发到同一个话题，否则会掉进 General
    const anchorThreadId = (await this.threadAnchor(submission))?.threadId;
    let sent;
    try {
      sent = await this.tg.sendMessage(target, body, { replyTo: anchor, threadId: anchorThreadId });
    } catch (error) {
      this.logger.warn?.(`公开发布评论失败：${error?.message ?? error}`);
      await this.tryReply(
        chatId,
        this.texts('republishFailed', { error: escapeHtml(String(error?.message ?? error)) }),
      );
      return true;
    }
    await this.store.rememberComment({
      chatId: target,
      messageId: sent.message_id,
      submissionId: submission.id,
      threadId: anchorThreadId ?? null,
      authorId: from.id,
      authorName: name,
      text,
    });
    if (Number(from.id) !== Number(submission.userId)) {
      await this.notifyAuthorAboutComment(
        submission,
        { chat: { id: target }, message_id: sent.message_id, text },
        from,
      );
    }
    await this.store.clearAdminAction(from.id);
    if (this.config.options.deleteUserMessages) await this.tryDelete(chatId, message.message_id);
    await this.tryReply(chatId, this.texts('publicCommentDone'));
    return true;
  }

  /** 当前生效设置的文本（/settings 和面板共用）。 */
  async buildSettingsText() {
    const target = await this.effectiveTargetChatId();
    const stored = await this.store.getSetting('target_chat_id');
    const targets = await this.store.listPublishTargets();
    const review = await this.isReviewMode();
    const topic = await this.effectiveThreadId();
    const reviewChat = await this.effectiveReviewChatId();
    const { rateLimitCount, rateLimitWindowSeconds, maxAttachments, maxDrafts, tag } = this.config.options;
    const rate =
      rateLimitCount > 0
        ? `每 ${Math.max(1, Math.round(rateLimitWindowSeconds / 60))} 分钟最多 ${rateLimitCount} 次`
        : '不限';
    let source = this.texts('settingsSourceNone');
    if (targets.length > 0) {
      source = `D1 授权目标（${targets.filter((item) => Number(item.enabled)).length}/${targets.length} 启用；/bind 设定的）`;
    } else if (target !== null) {
      source = stored !== null ? this.texts('settingsSourceDb') : this.texts('settingsSourceEnv');
    }
    return this.texts('settingsText', {
      target: targets.length > 0 ? targets.map((item) => item.chat_id).join(', ') : (target ?? '—'),
      source,
      topic:
        targets.length > 0
          ? (targets[0].thread_id ?? this.texts('bindWhereDefault'))
          : topic === null
            ? this.texts('bindWhereDefault')
            : topic,
      review: review ? '开启' : '关闭',
      review_chat: reviewChat === null ? this.texts('settingsReviewNone') : reviewChat,
      rate,
      max_attachments: maxAttachments,
      max_drafts: maxDrafts,
      tag: escapeHtml(tag),
      web: this.config.options.webEnabled
        ? this.texts('settingsWebOn', {
            review: (await this.webNeedsReview())
              ? this.texts('settingsWebNeedsReview')
              : this.texts('settingsWebDirect'),
            note:
              (await this.webNeedsReview()) && reviewChat === null
                ? `\n⚠️ ${this.texts('settingsWebNoReviewChat')}`
                : '',
          })
        : this.texts('settingsWebOff'),
    });
  }

  /**
   * 评论区自检：把"评论收不到"这件事变成用户能看懂、能自己修的提示。
   * 关键背景：Telegram 默认只把"命令 / @它 / 回复它自己消息"的群消息推给机器人，
   * 而频道帖的评论回复的是 Telegram 转发的副本，所以机器人必须是讨论组管理员，
   * 或者在 BotFather 里把隐私模式关掉，否则评论永远收不到。
   */
  chatTypeLabel(type) {
    return { channel: '频道', supergroup: '超级群', group: '群', private: '私聊' }[type] ?? (type || '会话');
  }

  /**
   * 评论区自检。
   *
   * 关键事实（之前这里说错了，导致误导）：
   * - **频道**里普通用户根本无法发言，评论只能来自频道关联的"讨论组"。
   *   频道没关联讨论组 = 没有任何评论入口，跟机器人无关。
   * - **普通群**里评论就是"回复机器人发的那条投稿"，而 Telegram 的隐私模式
   *   本来就会把"回复机器人自己消息"的消息推给机器人，所以通常不用改任何设置。
   * - 只有"频道 + 讨论组"这条链路，评论回复的是 Telegram 转发的副本而不是机器人发的，
   *   才需要机器人是讨论组管理员（或关掉隐私模式）。
   */
  async diagnoseCommentsText() {
    const targets = await this.store.listPublishTargets({ enabledOnly: true });
    const list =
      targets.length > 0
        ? targets
        : [{ chat_id: await this.effectiveTargetChatId(), title: '旧版单目标', thread_id: null }];
    const valid = list.filter((item) => item.chat_id !== null && item.chat_id !== undefined);
    if (valid.length === 0) return this.texts('diagNoTarget');

    const botId = await this.ensureBotId();
    const lines = [this.texts('diagTitle'), ''];
    for (const target of valid) {
      let info;
      try {
        info = await this.tg.getChat(target.chat_id);
      } catch (error) {
        lines.push(
          `• <code>${target.chat_id}</code> ${this.texts('diagChatError', {
            error: escapeHtml(String(error?.message ?? error)),
          })}`,
        );
        continue;
      }
      const type = info?.type ?? target.chat_type ?? 'unknown';
      const isChannel = type === 'channel';
      const title = info?.title || target.title || target.username || String(target.chat_id);
      lines.push(`• ${escapeHtml(title)} · ${this.chatTypeLabel(type)}（<code>${target.chat_id}</code>）`);

      const linked = info?.linked_chat_id ?? null;
      if (!linked) {
        lines.push(isChannel ? this.texts('diagChannelNoDiscussion') : this.texts('diagGroupNoLinked'));
        continue;
      }

      lines.push(this.texts('diagLinked', { chat_id: linked }));
      if (!botId) {
        lines.push(this.texts('diagBotUnknown'));
        continue;
      }
      try {
        const member = await this.tg.getChatMember(linked, botId);
        const status = member?.status;
        if (status === 'administrator' || status === 'creator') lines.push(this.texts('diagBotAdmin'));
        else if (status === 'member' || status === 'restricted') lines.push(this.texts('diagBotMember'));
        else lines.push(this.texts('diagBotOut'));
      } catch {
        lines.push(this.texts('diagBotOut'));
      }
      if (isChannel) lines.push(this.texts('diagChannelLinkedHint'));
    }
    if (!(await this.store.supportsCommentReplies())) lines.push('', this.texts('diagNeedsMigration'));
    lines.push('', this.texts('diagFix'));
    return lines.join('\n');
  }

  /** 评论区自检的自测键盘。 */
  diagKeyboard(chatId) {
    return singleButtonKeyboard(this.texts, 'btnDiagWatch', `a:dw:${chatId}`);
  }

  /** 布置一次"能不能收到群消息"的测试。 */
  async armDiagWatch(chatId, adminId) {
    await this.store.setSetting(`diag_watch:${chatId}`, `${adminId}:${nowSeconds()}`);
    return this.tryReply(chatId, this.texts('diagWatchArmed'), { raw: true });
  }

  /** 群里收到任何人的消息时，若布置过测试就私聊回报结果（一次性）。 */
  async checkDiagWatch(message) {
    const from = message.from;
    if (!from || from.is_bot) return;
    const key = `diag_watch:${message.chat.id}`;
    const raw = await this.store.getSetting(key);
    if (!raw) return;
    await this.store.clearSetting(key);
    const [rawAdmin, rawTs] = String(raw).split(':');
    const adminId = Number.parseInt(rawAdmin ?? '', 10);
    if (!Number.isFinite(adminId)) return;
    const age = nowSeconds() - (Number.parseInt(rawTs ?? '0', 10) || 0);
    if (age > 600) {
      await this.tryReply(adminId, this.texts('diagWatchExpired'), { raw: true });
      return;
    }
    await this.tryReply(
      adminId,
      this.texts('diagWatchOk', {
        chat_id: message.chat.id,
        name: escapeHtml(fullName(from)),
      }),
      { raw: true },
    );
  }

  /** 统一生成主菜单键盘（带上"有没有进行中的投稿"和"有几份草稿"）。 */
  async menuKeyboard(userId, { hasSession = null, draftCount = null } = {}) {
    const session = hasSession === null ? await this.store.getSession(userId) : null;
    const drafts = draftCount === null ? await this.store.countDrafts(userId) : draftCount;
    const templates = Object.entries(this.config.templates);
    return mainMenuKeyboard(this.texts, {
      hasSession: hasSession === null ? Boolean(session) : hasSession,
      draftCount: drafts,
      templates: templates.length > 1 ? templates : [],
      mainGroupUrl: this.config.mainGroupUrl,
      webPublicUrl: this.publicWebSubmitUrl(),
    });
  }

  /** 对外可用的网页投稿地址（网页投稿开着、并且配了 WEB_PUBLIC_URL 时才有）。 */
  publicWebSubmitUrl() {
    const { webEnabled, webPublicUrl } = this.config.options;
    return webEnabled && webPublicUrl ? webPublicUrl : null;
  }

  /** 会话里是否已经有实际内容（决定挂起时是存成草稿还是直接丢掉）。 */
  sessionHasContent(session, template) {
    if (!template) return false;
    for (const step of template.steps) {
      const value = session.data?.[step.id];
      if (step.type === 'media') {
        if (Array.isArray(value) && value.length > 0) return true;
        continue;
      }
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') {
        if (String(value.plain ?? '').trim()) return true;
        continue;
      }
      if (String(value).trim()) return true;
    }
    return false;
  }

  /** 草稿列表里的短标题。 */
  draftTitle(session, template) {
    const data = session.data ?? {};
    const source = textOf(data.body).trim() || textOf(data.title).trim();
    if (source) return truncate(source.replace(/\s+/g, ' '), 24);
    return template?.name ?? '草稿';
  }

  /** 把当前进行中的投稿挂起成一份草稿；没内容就直接清掉。 */
  async parkActiveDraft(userId) {
    const session = await this.store.getSession(userId);
    if (!session) return null;
    await this.hydrateSessionMedia(session);
    const template = this.config.templates[session.templateId];
    if (!this.sessionHasContent(session, template)) {
      await this.finishSession(userId);
      return null;
    }

    // 超过上限就把最旧的几份删掉（会告诉用户，不静默丢）
    const cap = this.config.options.maxDrafts;
    const existing = await this.store.listDrafts(userId, cap + 10);
    let dropped = 0;
    for (const old of existing.slice(Math.max(0, cap - 1))) {
      if (await this.store.deleteDraft(userId, old.id)) dropped += 1;
    }

    const state = this.sessionState(session);
    const data = this.submissionData(session);
    data.__state = {
      // 挂起时不可能还在发布；失败状态保留下来，恢复后还能重试
      phase: state.phase === 'publishing' ? 'failed' : (state.phase ?? 'collecting'),
      nonce: state.nonce,
      submissionId: state.submissionId ?? null,
      editing: false,
      previewMediaIds: [],
    };
    const draftId = await this.store.createDraft({
      userId,
      templateId: session.templateId,
      stepId: session.stepId ?? null,
      data,
      title: this.draftTitle(session, template),
    });
    await this.store.copySessionMediaToDraft(userId, draftId);
    await this.finishSession(userId);
    return { draftId, dropped };
  }

  /** 恢复一份草稿（当前进行中的会先挂起）。 */
  async resumeDraft(userId, draftId, chatId) {
    const draft = await this.store.getDraft(userId, draftId);
    if (!draft) return null;
    if (!this.config.templates[draft.templateId]) {
      await this.store.deleteDraft(userId, draftId);
      return null;
    }
    await this.parkActiveDraft(userId);
    const session = {
      userId,
      templateId: draft.templateId,
      stepId: draft.stepId ?? null,
      data: draft.data ?? {},
      promptChatId: chatId,
      promptMessageId: null,
    };
    await this.store.saveSession(session);
    await this.store.copyDraftMediaToSession(userId, draftId);
    await this.store.deleteDraft(userId, draftId);
    return session;
  }

  /** 按会话状态显示对应的界面（提问 / 确认页 / 验证）。 */
  async showSession(session, template, chatId, { notice } = {}) {
    if (session.stepId === CAPTCHA_STEP)
      return this.rerollCaptcha(session, chatId, { notice: this.texts('captchaTapHint') });
    if (session.stepId) return this.sendPrompt(session, template, chatId, { notice });
    return this.sendPreview(session, template, chatId, { notice });
  }

  /** 草稿列表。 */
  async showDrafts(chatId, userId, { query = null } = {}) {
    const drafts = await this.store.listDrafts(userId, this.config.options.maxDrafts);
    const keyboard = draftsKeyboard(this.texts, drafts);
    if (drafts.length === 0) {
      if (query?.message) {
        await this.tryEditMarkup(query.message.chat.id, query.message.message_id, this.texts('draftsEmpty'), {
          keyboard,
        });
        return null;
      }
      return this.reply(chatId, this.texts('draftsEmpty'), { keyboard });
    }
    const items = [];
    for (const draft of drafts) {
      const template = this.config.templates[draft.template_id];
      const step = draft.step_id ? findStep(template, draft.step_id) : null;
      const mediaCount = await this.store.countDraftMedia(draft.id);
      items.push(
        this.texts('draftItem', {
          id: draft.id,
          title: escapeHtml(draft.title || '（无标题）'),
          date: new Date(draft.updated_at * 1000).toISOString().slice(5, 16).replace('T', ' '),
          step: escapeHtml(step ? stepTitle(step) : this.texts('draftStepPreview')),
          media: mediaCount > 0 ? ` · ${mediaCount} 个附件` : '',
        }),
      );
    }
    const text = `${this.texts('draftsTitle')}\n\n${items.join('\n')}\n\n${this.texts('draftsHint')}`;
    if (query?.message) {
      await this.tryEditMarkup(query.message.chat.id, query.message.message_id, text, { keyboard });
      return null;
    }
    return this.reply(chatId, text, { keyboard, raw: true });
  }

  // ------------------------------------------------------------------
  // 投稿级发布租约：用户确认、管理员通过、重新发布都要先拿到它。
  // 它同时是"谁在发"的锁和"上次发到一半崩了"的时间戳，所以不会永久死锁。
  // ------------------------------------------------------------------

  async acquireSubmissionLease(submissionId, { reset = false } = {}) {
    const key = `s:${submissionId}`;
    const now = nowSeconds();
    if (reset) await this.store.resetGuard(key, submissionId);
    const claimed = await this.store.claimGuard(key, now, now + PUBLISH_LOCK_SECONDS);
    const locked = claimed || (await this.store.lockGuard(key, now, now + PUBLISH_LOCK_SECONDS));
    if (!locked) return false;
    await this.store.updateSubmission(submissionId, { status: 'publishing' });
    return true;
  }

  async releaseSubmissionLease(submissionId, { published = false } = {}) {
    const key = `s:${submissionId}`;
    if (published) await this.store.setGuardStatus(key, 'published');
    else await this.store.releaseGuard(key);
  }

  async isPublishInFlight(submissionId) {
    const guard = await this.store.getGuard(`s:${submissionId}`);
    return Boolean(guard?.locked_until && guard.locked_until >= nowSeconds());
  }

  // ------------------------------------------------------------------
  // 更新分发
  // ------------------------------------------------------------------

  async handleUpdate(update) {
    await this.ensureAdminBootstrap();
    if (update.message) return this.handleMessage(update.message);
    if (update.channel_post) return this.handleChannelPost(update.channel_post);
    if (update.callback_query) return this.handleCallbackQuery(update.callback_query);
    if (update.my_chat_member) return this.handleMyChatMember(update.my_chat_member);
    return undefined;
  }

  /** 被拉进群时主动报出群里 ID，省得用户去群里发指令查。 */
  async handleMyChatMember(memberUpdate) {
    const chat = memberUpdate.chat ?? {};
    const status = memberUpdate.new_chat_member?.status;
    if (!['member', 'administrator'].includes(status)) return undefined;
    if (!['group', 'supergroup'].includes(chat.type)) return undefined;

    const configured = (await this.effectiveTargetChatId()) === chat.id;
    const text = configured
      ? `✅ 已加入「${escapeHtml(chat.title ?? '本群')}」，这就是投稿发布的目标群，可以开始用了。`
      : `✅ 已加入「${escapeHtml(chat.title ?? '本群')}」\n\n${this.texts('bindHint')}\n\n` +
        `本群 ID：<code>${chat.id}</code>（也可以填到 wrangler.toml 的 TARGET_CHAT_ID）\n` +
        `记得把我设为群管理员，否则发帖和删消息会失败。`;

    const addedBy = memberUpdate.from?.id;
    if (addedBy) {
      const sent = await this.tryReply(addedBy, text, { raw: true });
      if (sent) return sent;
    }
    return this.tryReply(chat.id, text, { raw: true });
  }

  async handleMessage(message) {
    const from = message.from;
    if (!from || from.is_bot) return;
    const chat = message.chat ?? {};
    if (chat.type === 'private') return this.handlePrivateMessage(message);
    return this.handleGroupMessage(message);
  }

  // ------------------------------------------------------------------
  // 私聊
  // ------------------------------------------------------------------

  async handlePrivateMessage(message) {
    const from = message.from;
    const chatId = message.chat.id;
    const text = (message.text ?? message.caption ?? '').trim();
    await this.store.touchUser(from);

    // 1) 管理员正在等待输入（回复投稿者 / 驳回理由 / 改写文案）
    if (await this.isAdmin(from.id)) {
      // 「改媒体」时附件要收进暂存区，不能走文字逻辑
      if (await this.handleAdminPendingMedia(message, from, chatId)) return;
      const handled = await this.handleAdminPendingText(message, from, chatId, text);
      if (handled) return;
    }

    if (text.startsWith('/')) return this.handleCommand(message, { chatId, from, isPrivate: true });

    // 2) 匿名对话：回复某条对话消息，或点了「接着说」
    if (await this.handleThreadReply(message, from, chatId)) return;

    // 3) 投稿流程
    const session = await this.loadSession(from.id, { chatId });
    if (!session) return void (await this.reply(chatId, this.texts('unknown')));
    await this.hydrateSessionMedia(session);

    const template =
      this.config.templates[session.templateId] ?? this.config.templates[Object.keys(this.config.templates)[0]];
    if (session.stepId === CAPTCHA_STEP)
      return this.rerollCaptcha(session, chatId, { notice: this.texts('captchaTapHint') });

    const state = this.sessionState(session);
    const phase = state.phase ?? (session.stepId ? 'collecting' : 'preview');
    // 确认页/发布中/失败页：不能把用户随手打的话当成第一步的答案（会静默改掉正文）
    if (!session.stepId || (phase !== 'collecting' && !state.editing)) {
      // 理论上不该出现的中间态（collecting 却没有步骤）：直接补一份确认页，别让用户卡住
      if (!session.stepId && phase === 'collecting') {
        return void (await this.sendPreview(session, template, chatId));
      }
      return void (await this.reply(chatId, this.texts('previewHint')));
    }

    const step = findStep(template, session.stepId);
    if (!step) return void (await this.sendPreview(session, template, chatId));

    if (step.type === 'media') {
      const attachment = extractAttachment(message);
      if (!attachment) return void (await this.reply(chatId, this.texts('stepAttachmentExpected')));
      return this.handleAttachmentInput(message, session, step, chatId, attachment);
    }

    if (step.type === 'choice') {
      return void (await this.reply(chatId, this.texts('stepChoiceExpected')));
    }

    const raw = message.text ?? message.caption ?? '';
    if (!raw) return void (await this.reply(chatId, this.texts('stepTextExpected')));
    const error = validateAnswer(step, raw, this.config, this.texts);
    if (error) return void (await this.reply(chatId, error));

    await this.recordAnswer(session, step, { plain: raw.trim(), html: renderEntities(raw.trim(), message.entities) });
    if (this.config.options.deleteUserMessages) await this.tryDelete(chatId, message.message_id);
    await this.advance(session, template, chatId);
    return undefined;
  }

  /**
   * 附件步骤：图片、视频、文件、语音、位置、投票都能收。
   * 附件写进 session_media 表（append-only），不再读-改-写整个会话 JSON，
   * 所以相册并发投递时不会互相覆盖丢图。
   */
  async handleAttachmentInput(message, session, step, chatId, attachment) {
    const limit = this.config.options.maxAttachments;
    const count = await this.store.countSessionMedia(session.userId, step.id);

    if (count >= limit) {
      await this.tryReact(message.chat.id, message.message_id, '🤯');
      await this.reply(chatId, this.texts('stepMediaLimit', { max_attachments: limit }));
      return undefined;
    }

    let result;
    try {
      result = await this.store.appendSessionMedia(session.userId, step.id, attachment);
    } catch (error) {
      this.logger.error?.('保存附件失败', error);
      await this.reply(chatId, this.texts('mediaSaveFailed'));
      return undefined;
    }
    if (!result.inserted) {
      // 同一张图重复发：给个表情就好，不刷屏
      await this.tryReact(message.chat.id, message.message_id, '👍');
      return undefined;
    }

    await this.hydrateSessionMedia(session);
    await this.tryReact(message.chat.id, message.message_id, '✅');
    if (this.config.options.deleteUserMessages) await this.tryDelete(chatId, message.message_id);

    // 第一个附件到达时刷新提示消息：让「管理媒体」按钮和计数出现（最多 2 次额外编辑）
    if (count === 0 || count + 1 >= limit) await this.refreshMediaPrompt(session, step);
    return undefined;
  }

  /** 媒体步骤提示消息：刷新计数和「管理媒体」按钮。 */
  async refreshMediaPrompt(session, step) {
    if (!session.promptMessageId) return;
    const template = this.config.templates[session.templateId];
    if (!template) return;
    const steps = visibleSteps(template, session.data);
    const index = steps.findIndex((item) => item.id === step.id);
    const count = Array.isArray(session.data[step.id]) ? session.data[step.id].length : 0;
    const body = promptText(this.config, template, step, session.data, this.texts);
    const recorded = count > 0 ? this.texts('stepPhotosRecorded', { count }) : this.texts('stepPhotosNone');
    await this.tryEditMarkup(session.promptChatId, session.promptMessageId, `${body}\n\n${recorded}`, {
      keyboard: stepKeyboard(this.texts, step, { canBack: index > 0, mediaCount: count }),
    });
  }

  // ------------------------------------------------------------------
  // 指令
  // ------------------------------------------------------------------

  async handleCommand(message, { chatId, from, isPrivate }) {
    const text = (message.text ?? '').trim();
    const [commandToken, ...rest] = text.split(/\s+/);
    const command = commandToken.replace(/@[\w_]+$/, '').toLowerCase();
    const args = rest;
    const admin = await this.isAdmin(from.id);

    switch (command) {
      case '/start':
        return isPrivate ? this.onStart(chatId, from, args[0]) : undefined;
      case '/help':
        return this.reply(
          chatId,
          this.texts('help', { max_photos: this.config.options.maxPhotos }) +
            (admin ? `\n\n${this.texts('adminPanel')}` : ''),
          { keyboard: await this.menuKeyboard(from.id) },
        );
      case '/cancel':
        return this.onCancel(chatId, from, isPrivate);
      case '/drafts':
        return isPrivate ? this.showDrafts(chatId, from.id) : undefined;
      case '/my':
        return isPrivate ? this.userHistory(chatId, from.id) : undefined;
      case '/myid':
        return this.reply(chatId, this.texts('myid', { user_id: from.id }), { raw: true });
      case '/chatid':
        return this.reply(chatId, this.texts('chatid', { chat_id: chatId, chat_type: message.chat.type }), {
          raw: true,
        });
      case '/stats':
      case '/ban':
      case '/unban':
      case '/banlist':
      case '/admin':
      case '/bind':
      case '/topic':
      case '/review':
      case '/settings':
      case '/approve_all':
      case '/admins':
      case '/addadmin':
      case '/deladmin':
      case '/adminrole':
      case '/pending':
      case '/user':
      case '/audit':
      case '/mute':
      case '/unmute':
      case '/note':
      case '/comments':
      case '/diag':
      case '/targets':
        if (!admin) return this.reply(chatId, this.texts('adminOnly'));
        return this.handleAdminCommand(command, args, chatId, {
          chatType: message.chat.type,
          userId: from.id,
          threadId: message.message_thread_id,
        });
      default:
        return isPrivate ? this.reply(chatId, this.texts('unknown')) : undefined;
    }
  }

  async handleAdminCommand(command, args, chatId, { chatType, userId, threadId } = {}) {
    const ownerCommands = new Set(['/admins', '/addadmin', '/deladmin', '/adminrole', '/targets']);
    if (ownerCommands.has(command) && !(await this.canManageAdmins(userId)))
      return this.reply(chatId, this.texts('ownerOnly'));
    if (['/review', '/settings'].includes(command) && (await this.adminRole(userId)) === 'moderator') {
      return this.reply(chatId, this.texts('adminLevelDenied'));
    }
    switch (command) {
      case '/admin':
        return this.showAdminPanel(chatId);
      case '/admins':
        return this.adminList(chatId);
      case '/addadmin':
        return this.adminAdd(chatId, userId, args);
      case '/deladmin':
        return this.adminRemove(chatId, userId, args);
      case '/adminrole':
        return this.adminRoleChange(chatId, userId, args);
      case '/pending':
        return this.pendingList(chatId);
      case '/user':
        return this.userLookup(chatId, args);
      case '/audit':
        return this.auditList(chatId);
      case '/mute':
        return this.userMute(chatId, userId, args);
      case '/unmute':
        return this.userUnmute(chatId, userId, args);
      case '/note':
        return this.userNote(chatId, userId, args);
      case '/diag':
        return this.reply(chatId, await this.diagnoseCommentsText(), {
          raw: true,
          keyboard: this.diagKeyboard(chatId),
        });
      case '/comments': {
        const submissionId = Number.parseInt(args[0] ?? '', 10);
        const offset = Number.parseInt(args[1] ?? '0', 10);
        return this.adminComments(chatId, submissionId, Number.isFinite(offset) ? offset : 0);
      }
      case '/targets':
        return this.publishTargetsMenu(chatId, userId);

      case '/bind': {
        if (!(await this.canManageAdmins(userId))) return this.reply(chatId, this.texts('ownerOnly'));
        if (!['group', 'supergroup'].includes(chatType)) return this.reply(chatId, this.texts('bindPrivate'));
        const chat = await this.tg.getChat(chatId);
        const target = await this.store.upsertPublishTarget({
          chatId,
          chatType,
          title: chat?.title ?? null,
          username: chat?.username ?? null,
          threadId: threadId ?? null,
          threadTitle: null,
          addedBy: userId,
        });
        // 保留旧 settings 键，兼容已有部署与旧版 /settings；正式发布逻辑以 publish_targets 为准。
        await this.store.setSetting('target_chat_id', chatId);
        await this.store.setSetting('target_thread_id', threadId ?? '');
        await this.store.audit(
          userId,
          'publish_target.bind',
          'chat',
          chatId,
          threadId == null ? null : `thread=${threadId}`,
        );
        const where = threadId ? `本话题（${threadId}）` : '本群主聊天';
        const posted = await this.tryReply(
          chatId,
          `✅ 已把本群设为投稿发布群，同时授权为一个发布目标。\n「${escapeHtml(chat?.title ?? '本群')}」发布位置：${escapeHtml(where)}\n
可在私聊机器人发送 /targets 管理所有发布目标。` + (!threadId && chat?.is_forum ? this.texts('bindForumHint') : ''),
          { raw: true, threadId },
        );
        if (posted) return posted;
        if (target) await this.store.setPublishTargetEnabled(target.id, false);
        return this.tryReply(userId, this.texts('bindFailed'), { raw: true });
      }
      case '/topic': {
        // 发布话题的显式开关：/topic 发在哪个话题，投稿就发到哪个话题；
        // 发在主聊天（或 /topic off）则回到主聊天。以前只能靠重发 /bind 改，容易被误操作埋掉。
        if (!(await this.canManageAdmins(userId))) return this.reply(chatId, this.texts('ownerOnly'));
        if (!['group', 'supergroup'].includes(chatType)) return this.reply(chatId, this.texts('bindPrivate'));
        const target = await this.store.getPublishTargetByChat(chatId);
        if (!target) return this.reply(chatId, this.texts('topicNotBound'), { raw: true });

        const arg = String(args[0] ?? '').toLowerCase();
        const off = ['off', '0', 'none', 'main'].includes(arg);
        const explicit = Number.parseInt(arg, 10);
        if (arg && !off && !Number.isFinite(explicit)) {
          return this.reply(chatId, this.texts('topicUsage'), { raw: true });
        }
        // 没有参数时：在话题里发 = 设为该话题；在主聊天发 = 回到主聊天
        const nextThreadId = off ? null : Number.isFinite(explicit) ? explicit : (threadId ?? null);

        if (nextThreadId === null) {
          await this.store.setPublishTargetThread(target.id, null, null);
          await this.store.setSetting('target_thread_id', '');
          await this.store.audit(userId, 'publish_target.topic', 'chat', chatId, 'main');
          return this.reply(chatId, this.texts('topicCleared'), { raw: true });
        }
        await this.store.setPublishTargetThread(target.id, nextThreadId, null);
        await this.store.setSetting('target_thread_id', String(nextThreadId));
        await this.store.audit(userId, 'publish_target.topic', 'chat', chatId, `thread=${nextThreadId}`);
        return this.reply(chatId, this.texts('topicSet', { thread_id: nextThreadId }), {
          raw: true,
          threadId: nextThreadId,
        });
      }
      case '/review': {
        const arg = String(args[0] ?? '').toLowerCase();
        if (!['on', 'off'].includes(arg)) return this.reply(chatId, this.texts('reviewUsage'));
        if (arg === 'on' && (await this.effectiveReviewChatId()) === null) {
          // 不能把审核消息发到公开目标群，否则等于未审先发
          return this.reply(chatId, this.texts('reviewNotConfigured'), { raw: true });
        }
        await this.store.setSetting('require_review', arg === 'on' ? '1' : '0');
        await this.store.audit(userId, 'settings.review', 'setting', 'require_review', arg);
        return this.reply(chatId, this.texts(arg === 'on' ? 'reviewOn' : 'reviewOff'));
      }
      case '/settings':
        return this.reply(chatId, await this.buildSettingsText(), { raw: true });
      case '/stats': {
        const stats = await this.store.stats();
        return this.reply(chatId, this.texts('adminStats', stats));
      }
      case '/approve_all': {
        // 不再限制 20 条：分批循环处理，直到没有待审核的为止。
        // 用 seen 记住处理过的 id，避免"发布失败退回 pending"导致死循环。
        const batchSize = 20;
        const hardCap = 200;
        const seen = new Set();
        let done = 0;
        let failed = 0;
        for (;;) {
          const pending = (await this.store.listPending(batchSize)).filter((row) => !seen.has(row.id));
          if (pending.length === 0) break;
          for (const submission of pending) {
            seen.add(submission.id);
            const template = this.config.templates[submission.templateId];
            // 和单条「通过」共用同一把投稿级租约：批量通过、手动通过、用户自己发布三者互斥
            if (!(await this.acquireSubmissionLease(submission.id))) {
              failed += 1;
              continue;
            }
            try {
              const published = await this.publish(submission, template, { review: false });
              await this.releaseSubmissionLease(submission.id, { published: true });
              const link = linkForMessage(published.chatId, published.messageId, await this.ensureTargetChat());
              await this.tryReply(
                submission.userId,
                link ? this.texts('approved', { link }) : this.texts('submittedNoLink'),
              );
              done += 1;
            } catch (error) {
              this.logger.error?.(`批量通过失败 #${submission.id}`, error);
              await this.releaseSubmissionLease(submission.id);
              await this.store.updateSubmission(submission.id, { status: error?.partial ? 'failed' : 'pending' });
              failed += 1;
            }
          }
          if (seen.size >= hardCap) break;
        }
        if (seen.size === 0) return this.reply(chatId, this.texts('batchApproveNone'));
        const remaining = (await this.store.listPending(batchSize)).filter((row) => !seen.has(row.id)).length;
        let text =
          failed > 0
            ? this.texts('batchApprovePartial', { count: done, failed })
            : this.texts('batchApproveDone', { count: done });
        if (remaining > 0) text += `\n${this.texts('batchApproveRemaining', { n: remaining })}`;
        return this.reply(chatId, text);
      }
      case '/ban': {
        const targetUserId = Number.parseInt(args[0] ?? '', 10);
        if (!Number.isFinite(targetUserId)) return this.reply(chatId, this.texts('adminBanUsage'));
        await this.store.ban(targetUserId, args.slice(1).join(' '));
        await this.store.audit(userId, 'user.ban', 'user', targetUserId, args.slice(1).join(' '));
        return this.reply(chatId, this.texts('adminBanned', { user_id: targetUserId }));
      }
      case '/unban': {
        const targetUserId = Number.parseInt(args[0] ?? '', 10);
        if (!Number.isFinite(targetUserId)) return this.reply(chatId, this.texts('adminUnbanUsage'));
        await this.store.unban(targetUserId);
        await this.store.audit(userId, 'user.unban', 'user', targetUserId);
        return this.reply(chatId, this.texts('adminUnbanned', { user_id: targetUserId }));
      }
      case '/banlist': {
        const bans = await this.store.listBans();
        if (bans.length === 0) return this.reply(chatId, this.texts('adminBanlistEmpty'));
        const items = bans
          .map((row) => `• <code>${row.user_id}</code>${row.reason ? ` · ${escapeHtml(row.reason)}` : ''}`)
          .join('\n');
        return this.reply(chatId, this.texts('adminBanlist', { items }), { raw: true });
      }
      default:
        return undefined;
    }
  }

  // ------------------------------------------------------------------
  // 管理后台：管理员 / 队列 / 用户 / 审计
  // ------------------------------------------------------------------

  async adminList(chatId) {
    const rows = await this.store.listAdmins();
    if (rows.length === 0) return this.reply(chatId, this.texts('adminsEmpty'));
    const items = rows
      .map((row) => `• <code>${row.user_id}</code> · ${escapeHtml(this.adminRoleLabel(row.role))}`)
      .join('\n');
    return this.reply(chatId, `${this.texts('adminsTitle')}\n\n${items}\n\n${this.texts('adminsUsage')}`, {
      raw: true,
    });
  }

  async adminAdd(chatId, actorId, args) {
    if (!(await this.canManageAdmins(actorId))) return this.reply(chatId, this.texts('ownerOnly'));
    const target = Number.parseInt(args[0] ?? '', 10);
    const role = args[1] ?? 'admin';
    if (!Number.isFinite(target) || !['owner', 'admin', 'moderator'].includes(role)) {
      return this.reply(chatId, this.texts('adminAddUsage'));
    }
    await this.store.addAdmin(target, role, actorId);
    await this.store.audit(actorId, 'admin.add', 'user', target, `role=${role}`);
    return this.reply(chatId, this.texts('adminAdded', { user_id: target, role: this.adminRoleLabel(role) }));
  }

  async adminRemove(chatId, actorId, args) {
    if (!(await this.canManageAdmins(actorId))) return this.reply(chatId, this.texts('ownerOnly'));
    const target = Number.parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(target)) return this.reply(chatId, this.texts('adminRemoveUsage'));
    if (this.config.admins.includes(target)) return this.reply(chatId, this.texts('adminEnvProtected'));
    const row = await this.store.getAdmin(target);
    if (!row) return this.reply(chatId, this.texts('adminNotFound'));
    if (row.role === 'owner' && (await this.store.countOwners()) <= 1) {
      return this.reply(chatId, this.texts('lastOwnerProtected'));
    }
    await this.store.removeAdmin(target);
    await this.store.audit(actorId, 'admin.remove', 'user', target, `role=${row.role}`);
    return this.reply(chatId, this.texts('adminRemoved', { user_id: target }));
  }

  async adminRoleChange(chatId, actorId, args) {
    if (!(await this.canManageAdmins(actorId))) return this.reply(chatId, this.texts('ownerOnly'));
    const target = Number.parseInt(args[0] ?? '', 10);
    const role = args[1] ?? '';
    if (!Number.isFinite(target) || !['owner', 'admin', 'moderator'].includes(role)) {
      return this.reply(chatId, this.texts('adminRoleUsage'));
    }
    if (this.config.admins.includes(target) && role !== 'owner')
      return this.reply(chatId, this.texts('adminEnvProtected'));
    const row = await this.store.getAdmin(target);
    if (!row) return this.reply(chatId, this.texts('adminNotFound'));
    if (row.role === 'owner' && role !== 'owner' && (await this.store.countOwners()) <= 1) {
      return this.reply(chatId, this.texts('lastOwnerProtected'));
    }
    await this.store.addAdmin(target, role, actorId);
    await this.store.audit(actorId, 'admin.role', 'user', target, `role=${role}`);
    return this.reply(chatId, this.texts('adminRoleChanged', { user_id: target, role: this.adminRoleLabel(role) }));
  }

  async pendingList(chatId) {
    const pending = await this.store.listPending(20);
    if (pending.length === 0) return this.reply(chatId, this.texts('pendingEmpty'));
    const items = pending
      .map((row) => {
        const body = truncate(textOf(row.data.body), 80).replace(/\n/g, ' ');
        return `• #${row.id} · ${escapeHtml(row.fullName || row.username || String(row.userId))} · ${escapeHtml(body || '（无正文）')}`;
      })
      .join('\n');
    return this.reply(chatId, `${this.texts('pendingTitle')}\n\n${items}\n\n${this.texts('pendingHint')}`, {
      raw: true,
    });
  }

  async userLookup(chatId, args) {
    const userId = Number.parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(userId)) return this.reply(chatId, this.texts('userUsage'));
    const data = await this.store.getUserAdminData(userId);
    if (!data.user && !data.ban) return this.reply(chatId, this.texts('userNotFound', { user_id: userId }));
    const u = data.user;
    const name = u?.full_name || u?.username || String(userId);
    const ban = data.ban ? `🚫 已拉黑${data.ban.reason ? `：${escapeHtml(data.ban.reason)}` : ''}` : '✅ 未拉黑';
    const mute =
      data.control?.muted_until && data.control.muted_until > nowSeconds()
        ? `🔇 静音至 ${data.control.muted_until}`
        : '🔊 未静音';
    const note = data.control?.note ? `\n备注：${escapeHtml(data.control.note)}` : '';
    return this.reply(
      chatId,
      `👤 <b>用户 ${userId}</b>\n\n名称：${escapeHtml(name)}\n用户名：${escapeHtml(u?.username ? `@${u.username}` : '—')}\n` +
        `首次出现：${u?.first_seen ?? '—'}\n最近活动：${u?.last_seen ?? '—'}\n\n${ban}\n${mute}${note}\n\n` +
        `投稿：${data.stats.total} · 已发布 ${data.stats.published} · 待审 ${data.stats.pending} · 拒绝 ${data.stats.rejected} · 撤回 ${data.stats.recalled}`,
      { raw: true },
    );
  }

  async auditList(chatId) {
    const rows = await this.store.listAudit(20);
    if (rows.length === 0) return this.reply(chatId, this.texts('auditEmpty'));
    const items = rows
      .map(
        (row) =>
          `• ${row.id} · <code>${row.actor_id}</code> · ${escapeHtml(row.action)} · ${escapeHtml(row.target_id ?? '—')}`,
      )
      .join('\n');
    return this.reply(chatId, `${this.texts('auditTitle')}\n\n${items}`, { raw: true });
  }

  async userMute(chatId, actorId, args) {
    const target = Number.parseInt(args[0] ?? '', 10);
    const minutes = Number.parseInt(args[1] ?? '60', 10);
    if (!Number.isFinite(target) || !Number.isFinite(minutes) || minutes < 1)
      return this.reply(chatId, this.texts('muteUsage'));
    await this.store.muteUser(target, minutes * 60, actorId);
    await this.store.audit(actorId, 'user.mute', 'user', target, `minutes=${minutes}`);
    return this.reply(chatId, this.texts('mutedDone', { user_id: target, minutes }));
  }

  async userUnmute(chatId, actorId, args) {
    const target = Number.parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(target)) return this.reply(chatId, this.texts('unmuteUsage'));
    await this.store.muteUser(target, 0, actorId);
    await this.store.audit(actorId, 'user.unmute', 'user', target);
    return this.reply(chatId, this.texts('unmutedDone', { user_id: target }));
  }

  async userNote(chatId, actorId, args) {
    const target = Number.parseInt(args[0] ?? '', 10);
    const note = args.slice(1).join(' ').trim();
    if (!Number.isFinite(target) || !note) return this.reply(chatId, this.texts('noteUsage'));
    await this.store.setUserNote(target, note, actorId);
    await this.store.audit(actorId, 'user.note', 'user', target);
    return this.reply(chatId, this.texts('noteDone', { user_id: target }));
  }

  async onStart(chatId, from, payload) {
    if (await this.store.isBanned(from.id)) return this.reply(chatId, this.texts('banned'));
    // 从投稿上的「💬 评论」按钮跳进来（?start=c_<投稿ID>）
    const commentMatch = /^c_(\d+)$/.exec(String(payload ?? ''));
    if (commentMatch) return this.startPublicComment(chatId, from, Number.parseInt(commentMatch[1], 10));
    const problems = await this.currentProblems();
    if (problems.length > 0) return this.replyNotConfigured(chatId, from.id, problems);
    const session = await this.loadSession(from.id, { chatId });
    const keyboard = await this.menuKeyboard(from.id, { hasSession: Boolean(session) });
    // 网页投稿是"没装 Telegram / 在国内"的人唯一的入口，欢迎语里直接给出可复制、可转发的地址
    const webUrl = this.publicWebSubmitUrl();
    const webLine = webUrl ? `\n\n${this.texts('webSubmitIntro', { url: escapeHtml(webUrl) })}` : '';
    const text = `${this.texts('welcome', { name: from.first_name ?? '朋友' })}\n\n${this.config.mainGroupUrl ? this.texts('mainGroupIntro') : ''}${webLine}\n\n${this.texts('menu')}`;
    return this.reply(chatId, text, { keyboard });
  }

  async onCancel(chatId, from, isPrivate) {
    const session = await this.store.getSession(from.id);
    if (!session) return this.reply(chatId, this.texts('nothingToCancel'));
    await this.finishSession(from.id);
    if (!isPrivate) return undefined;
    return this.reply(chatId, this.texts('cancelled'), {
      keyboard: await this.menuKeyboard(from.id, { hasSession: false }),
    });
  }

  /** 用户自己的投稿历史与状态（/my）。 */
  async userHistory(chatId, userId) {
    const rows = await this.store.listUserSubmissions(userId, 10);
    if (rows.length === 0) return this.reply(chatId, this.texts('historyEmpty'));
    const statusKeys = {
      pending: 'statusPending',
      publishing: 'statusPublishing',
      published: 'statusPublished',
      rejected: 'statusRejected',
      recalled: 'statusRecalled',
      failed: 'statusFailed',
      deleted: 'statusDeleted',
    };
    const username = await this.ensureTargetChat();
    const items = rows
      .map((row) => {
        const date = new Date((row.publishedAt ?? row.createdAt) * 1000).toISOString().slice(0, 10);
        // 只有真正公开发布过的才给链接：待审的消息在审核群里，用户看不到也不该暴露
        const link =
          row.status === 'published' ? linkForMessage(row.publishChatId, row.publishMessageId, username) : '';
        return this.texts('historyItem', {
          id: row.id,
          status: this.texts(statusKeys[row.status] ?? 'statusPending'),
          date,
          link: link ? `\n🔗 ${link}` : '',
        });
      })
      .join('\n');
    return this.reply(chatId, `${this.texts('historyTitle')}\n\n${items}\n\n${this.texts('historyHint')}`, {
      raw: true,
    });
  }

  // ------------------------------------------------------------------
  // 投稿流程
  // ------------------------------------------------------------------

  async startWizard(chatId, from, templateId, { restart = false } = {}) {
    if (await this.store.isBanned(from.id)) return this.reply(chatId, this.texts('banned'));
    const problems = await this.currentProblems();
    if (problems.length > 0) return this.replyNotConfigured(chatId, from.id, problems);
    const id = this.config.templates[templateId] ? templateId : Object.keys(this.config.templates)[0];
    const template = this.config.templates[id];
    const previous = restart ? null : await this.loadSession(from.id, { chatId });

    // 继续上次的进度（含"还停在确认页"的情况）
    if (previous && previous.templateId === id) {
      await this.hydrateSessionMedia(previous);
      previous.userId = from.id;
      previous.promptChatId = chatId;
      await this.persistSession(previous);
      return this.showSession(previous, template, chatId, { notice: this.texts('sessionResumed') });
    }

    const state = {
      phase: 'collecting',
      nonce: randomNonce(),
      editing: false,
      previewMediaIds: [],
      submissionId: null,
      lastError: null,
      user: { fullName: fullName(from), username: from.username ?? null },
    };

    // 全新投稿：先过一道真人验证（防脚本刷投稿）
    if (this.config.options.captcha) {
      const session = {
        userId: from.id,
        templateId: id,
        data: { __state: state },
        stepId: CAPTCHA_STEP,
        promptChatId: chatId,
        promptMessageId: null,
      };
      await this.persistSession(session);
      return this.sendCaptcha(session, chatId, template);
    }

    const step = firstStep(template, {});
    const session = {
      userId: from.id,
      templateId: id,
      data: { __state: state },
      stepId: step?.id ?? null,
      promptChatId: chatId,
      promptMessageId: null,
    };
    await this.persistSession(session);
    if (!step) return this.sendPreview(session, template, chatId);
    return this.sendPrompt(session, template, chatId, { notice: template.welcome });
  }

  /**
   * 真人验证：随机挑几个表情，让用户点出指定的那个。
   * 抽题与发送拆开，是因为"点错了"要在原消息上换一道题，
   * 而不是每错一次就往聊天里多堆一条。
   */
  rollCaptcha(session) {
    const previous = session.data.__captcha ?? {};
    const emojis = shuffle(CAPTCHA_EMOJIS).slice(0, 4);
    const targetIndex = Math.floor(Math.random() * emojis.length);
    session.stepId = CAPTCHA_STEP;
    session.data.__captcha = { targetIndex, tries: previous.tries ?? 0, emojis };
    const remaining = Math.max(0, CAPTCHA_MAX_TRIES - (previous.tries ?? 0));
    return {
      emojis,
      targetIndex,
      text: `${this.texts('captchaPrompt', { target: emojis[targetIndex] })}\n\n${this.texts('captchaRemaining', {
        remaining,
      })}`,
      keyboard: captchaKeyboard(emojis),
    };
  }

  /** 首题：发一条新消息（开始投稿时用）。 */
  async sendCaptcha(session, chatId) {
    const rolled = this.rollCaptcha(session);
    const sent = await this.tg.sendMessage(chatId, rolled.text, { keyboard: rolled.keyboard });
    session.promptChatId = chatId;
    session.promptMessageId = sent.message_id;
    await this.persistSession(session);
    return sent;
  }

  /** 换题：优先原地改那条验证消息，改不动才退回发新消息。 */
  async rerollCaptcha(session, chatId, { notice } = {}) {
    const current = session.data.__captcha ?? {};
    const rolled = this.rollCaptcha(session);
    session.data.__captcha.tries = current.tries ?? 0;
    const text = notice ? `${notice}\n\n${rolled.text}` : rolled.text;
    const edited =
      session.promptMessageId &&
      (await this.tryEditMarkup(session.promptChatId, session.promptMessageId, text, { keyboard: rolled.keyboard }));
    if (edited) {
      await this.persistSession(session);
      return true;
    }
    const sent = await this.tg.sendMessage(chatId, text, { keyboard: rolled.keyboard });
    session.promptChatId = chatId;
    session.promptMessageId = sent.message_id;
    await this.persistSession(session);
    return true;
  }

  async sendPrompt(session, template, chatId, { notice } = {}) {
    const step = session.stepId ? findStep(template, session.stepId) : null;
    if (!step) return this.sendPreview(session, template, chatId, { notice });
    const steps = visibleSteps(template, session.data);
    const index = steps.findIndex((item) => item.id === step.id);
    const body = promptText(this.config, template, step, session.data, this.texts);
    const text = notice ? `${escapeHtml(notice)}\n\n${body}` : body;
    const mediaCount = step.type === 'media' && Array.isArray(session.data[step.id]) ? session.data[step.id].length : 0;
    const keyboard = stepKeyboard(this.texts, step, { canBack: index > 0, mediaCount });
    const sent = await this.sendOrRecover(chatId, text, keyboard, session.userId);
    session.promptChatId = chatId;
    session.promptMessageId = sent?.message_id ?? session.promptMessageId;
    await this.persistSession(session);
    return sent;
  }

  /** 发消息；发不出去时给一条带主菜单的兜底，别让用户对着没有按钮的界面发呆。 */
  async sendOrRecover(chatId, text, keyboard, userId = null) {
    try {
      return await this.tg.sendMessage(chatId, text, { keyboard });
    } catch (error) {
      this.logger.error?.('发送消息失败', error);
      const fallback = userId ? await this.menuKeyboard(userId, { hasSession: false }) : undefined;
      return this.tryReply(chatId, this.texts('previewSendFailed'), { raw: true, keyboard: fallback });
    }
  }

  async recordAnswer(session, step, value) {
    session.data[step.id] = value;
    await this.persistSession(session);
    await this.editPrompt(session, step);
  }

  /** 把用户答过的那条提问消息改成「已记录 xxx」，并去掉按钮。 */
  async editPrompt(session, step) {
    if (!session.promptMessageId) return;
    const template = this.config.templates[session.templateId];
    const value = session.data[step.id];
    let recorded;
    if (step.type === 'media') {
      const count = Array.isArray(value) ? value.length : 0;
      recorded = count > 0 ? this.texts('stepPhotosRecorded', { count }) : this.texts('stepPhotosNone');
    } else if (step.type === 'choice') {
      recorded = this.texts('stepRecordedChoice', { value: escapeHtml(String(value ?? '')) });
    } else {
      const valueText = escapeHtml(truncate(textOf(value), 200));
      recorded = valueText ? `${this.texts('stepRecordedText')} ${valueText}` : this.texts('stepRecordedText');
    }
    const body = promptText(this.config, template, step, session.data, this.texts);
    try {
      await this.tg.editMessageText(session.promptChatId, session.promptMessageId, `${body}\n\n${recorded}`, {
        removeKeyboard: true,
      });
    } catch (error) {
      this.logger.warn?.('编辑提问消息失败，已忽略', error?.message ?? error);
    }
  }

  async advance(session, template, chatId) {
    const state = this.sessionState(session);
    // 编辑模式：只改这一项，改完直接回确认页，不用把后面每一步再走一遍
    if (state.editing) {
      state.editing = false;
      session.stepId = null;
      await this.persistSession(session);
      return this.sendPreview(session, template, chatId);
    }
    const step = session.stepId ? findStep(template, session.stepId) : null;
    const next = step ? nextStep(template, session.data, step.id) : null;
    if (!next) return this.sendPreview(session, template, chatId);
    session.stepId = next.id;
    await this.persistSession(session);
    return this.sendPrompt(session, template, chatId);
  }

  /**
   * 确认页：先把媒体真实发到私聊让用户核对，再列出逐项内容 + 最终发布文案。
   * 只有用户点「✅ 确认发布」之后才会真正发到目标群。
   */
  async sendPreview(session, template, chatId, { notice } = {}) {
    const state = this.sessionState(session);
    if (state.phase !== 'publishing') state.phase = 'preview';
    session.stepId = null;

    const attachments = attachmentsOf(session.data, template);
    await this.clearPreviewMedia(session, chatId);
    let mediaFailed = false;
    if (attachments.length > 0) {
      const previewable = attachments.filter((item) => PREVIEWABLE.has(item.kind));
      if (previewable.length > 0) {
        try {
          const messages = await this.sendAttachments(chatId, previewable, {
            caption: this.texts('previewMediaCaption'),
          });
          state.previewMediaIds = messages.map((item) => item?.message_id).filter(Boolean);
        } catch (error) {
          mediaFailed = true;
          this.logger.warn?.(`预览媒体失败：${error?.message ?? error}`);
        }
      }
    }
    state.previewMediaFailed = mediaFailed;

    const lines = previewLines(this.config, template, session.data, this.texts);
    const noticePart = notice ? `${escapeHtml(notice)}\n\n` : '';
    const head = `${noticePart}${this.texts('preview', { content: lines.join('\n') })}`;
    const draftTitle = `\n\n${this.texts('previewDraftTitle')}\n\n`;
    const extra = mediaFailed ? `\n<i>${escapeHtml(this.texts('previewMediaFailed'))}</i>` : '';
    const budget = Math.max(200, PREVIEW_BUDGET - head.length - draftTitle.length - extra.length);
    const draft = fitHtml(this.previewDraft(session, template), budget);
    // 兜底：模板步骤特别多/字段特别长时，整条也不能超过 Telegram 的上限
    const body = fitHtml(`${head}${draftTitle}${draft}${extra}`, PREVIEW_BUDGET + 100);

    const sent = await this.sendOrRecover(
      chatId,
      body,
      previewKeyboard(this.texts, { hasMedia: attachments.length > 0 }),
      session.userId,
    );
    session.promptChatId = chatId;
    session.promptMessageId = sent?.message_id ?? session.promptMessageId;
    state.editing = false;
    await this.persistSession(session);
    return sent;
  }

  /** 确认页里「发布后的样子」：和真正发出去的文案走同一套渲染。 */
  previewDraft(session, template) {
    const state = this.sessionState(session);
    const user = state.user ?? {};
    return composeSubmission(this.config, {
      data: session.data,
      template,
      submissionId: state.submissionId,
      idText: '#（发布时分配）',
      user: { fullName: user.fullName, username: user.username },
      attachments: attachmentsOf(session.data, template),
    });
  }

  /** 重新生成确认页前，先把上一次发出去的预览媒体删掉，避免刷屏。 */
  async clearPreviewMedia(session, chatId) {
    const state = this.sessionState(session);
    const ids = Array.isArray(state.previewMediaIds) ? state.previewMediaIds : [];
    for (const messageId of ids) await this.tryDelete(chatId, messageId);
    state.previewMediaIds = [];
  }

  /** 「编辑内容」菜单：点哪一项就只改哪一项，改完自动回确认页。 */
  async sendEditMenu(session, template, chatId, { query = null } = {}) {
    const steps = visibleSteps(template, session.data).map((step, index) => ({
      id: step.id,
      label: stepTitle(step),
      index: index + 1,
    }));
    if (steps.length === 0) {
      await this.answer(query?.id);
      return this.reply(chatId, this.texts('editMenuNone'));
    }
    const text = `${this.texts('editMenuTitle')}\n\n${this.texts('editMenuHint')}`;
    const keyboard = editMenuKeyboard(this.texts, steps);
    if (query?.message) {
      try {
        await this.tg.editMessageText(query.message.chat.id, query.message.message_id, text, { keyboard });
        session.promptChatId = query.message.chat.id;
        session.promptMessageId = query.message.message_id;
        await this.persistSession(session);
        return null;
      } catch (error) {
        this.logger.warn?.(`打开编辑菜单失败：${error?.message ?? error}`);
      }
    }
    const sent = await this.tg.sendMessage(chatId, text, { keyboard });
    session.promptChatId = chatId;
    session.promptMessageId = sent.message_id;
    await this.persistSession(session);
    return sent;
  }

  /** 媒体管理面板：原地编辑同一条消息，保证按钮始终有效。 */
  async sendMediaManager(session, template, chatId, stepId, { query = null, from = 'step' } = {}) {
    const step = findStep(template, stepId);
    if (!step || step.type !== 'media') return this.sendPreview(session, template, chatId);
    const state = this.sessionState(session);
    state.mediaStepId = stepId;
    state.mediaFrom = from;
    const items = Array.isArray(session.data[stepId]) ? session.data[stepId] : [];
    const body =
      items.length === 0
        ? `${this.texts('mediaManagerTitle', { count: 0 })}\n\n${this.texts('mediaManagerEmpty')}`
        : `${this.texts('mediaManagerTitle', { count: items.length })}\n\n${this.texts('mediaManagerHint')}`;
    const keyboard = mediaManagerKeyboard(this.texts, stepId, items);
    if (query?.message) {
      try {
        await this.tg.editMessageText(query.message.chat.id, query.message.message_id, body, { keyboard });
        session.promptChatId = query.message.chat.id;
        session.promptMessageId = query.message.message_id;
        await this.persistSession(session);
        return null;
      } catch (error) {
        this.logger.warn?.(`刷新媒体面板失败：${error?.message ?? error}`);
      }
    }
    const sent = await this.tg.sendMessage(chatId, body, { keyboard });
    session.promptChatId = chatId;
    session.promptMessageId = sent.message_id;
    await this.persistSession(session);
    return sent;
  }

  /** 媒体面板里的删除 / 上移 / 下移。 */
  async onMediaAction(query, session, template, chatId, rest) {
    const [stepId, rawId, op] = rest;
    const mediaId = Number.parseInt(rawId ?? '', 10);
    const step = findStep(template, stepId);
    if (!step || !Number.isFinite(mediaId)) {
      await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
      return undefined;
    }
    let ok;
    let message = this.texts('mediaNotFound');
    if (op === 'del') {
      ok = await this.store.deleteSessionMedia(query.from.id, mediaId);
      if (ok) message = this.texts('mediaDeleted');
    } else if (op === 'up' || op === 'down') {
      ok = await this.store.moveSessionMedia(query.from.id, stepId, mediaId, op);
      message = ok ? this.texts('mediaMoved') : this.texts('mediaMovedEdge');
    }
    await this.hydrateSessionMedia(session);
    await this.answer(query.id, { text: message });
    return this.sendMediaManager(session, template, chatId, stepId, {
      query,
      from: this.sessionState(session).mediaFrom ?? 'step',
    });
  }

  /**
   * 真正提交：幂等 + 加锁 + 可恢复。
   * - 幂等键 `w:<user>:<nonce>`：连点/超时重投只会产生一条投稿
   * - 租约锁：并发的第二次点击直接被告知「正在发布中」
   * - 失败只释放锁、保留投稿，让用户原地重试
   */
  async submit(session, from, chatId, template) {
    const state = this.sessionState(session);
    if (await this.store.isBanned(from.id)) return this.reply(chatId, this.texts('banned'));
    if (await this.store.isMuted(from.id)) return this.reply(chatId, this.texts('mutedUser'));

    const review = await this.isReviewMode();
    const reviewChatId = await this.effectiveReviewChatId();
    if (review) {
      // 审核群必须是独立会话：不能是任何一个启用的发布目标，也不能没配
      const targets = await this.effectivePublishTargets();
      const conflict = reviewChatId === null || targets.some((target) => target.chat_id === reviewChatId);
      if (conflict) {
        state.phase = 'preview';
        await this.notifyAdmins('⚠️ 审核模式已开启，但审核群缺失或和发布群相同，投稿无法提交。');
        const notice = await this.reply(
          chatId,
          this.texts(reviewChatId === null ? 'reviewNotConfigured' : 'reviewChatConflict'),
          {
            raw: true,
            keyboard: previewKeyboard(this.texts, { hasMedia: attachmentsOf(session.data, template).length > 0 }),
          },
        );
        session.promptChatId = chatId;
        session.promptMessageId = notice?.message_id ?? session.promptMessageId;
        await this.persistSession(session);
        return undefined;
      }
    }

    const nonce = state.nonce ?? randomNonce();
    state.nonce = nonce;
    const guardKey = `w:${from.id}:${nonce}`;

    const guard = await this.store.getGuard(guardKey);
    if (guard?.status === 'published') {
      state.phase = 'preview';
      await this.persistSession(session);
      return this.reply(chatId, this.texts('alreadySubmitted'));
    }
    if (guard?.status === 'submitted') {
      state.phase = 'preview';
      await this.persistSession(session);
      return this.reply(chatId, this.texts('alreadySubmittedReview'));
    }

    // 限流只在第一次提交时计（重试不再重复消耗额度）；内容筛查每次都做（用户可能改过内容）
    if (!guard?.submission_id) {
      const { rateLimitCount, rateLimitWindowSeconds } = this.config.options;
      if (rateLimitCount > 0 && rateLimitWindowSeconds > 0) {
        const recent = await this.store.countRecentSubmissions(from.id, rateLimitWindowSeconds);
        if (recent >= rateLimitCount) {
          const minutes = Math.max(1, Math.ceil(rateLimitWindowSeconds / 60));
          // 重新发一遍确认页（带按钮），否则用户手里只剩一条没有按钮的「正在发布」
          return this.sendPreview(session, template, chatId, {
            notice: this.texts('rateLimited', { minutes }),
          });
        }
      }
    }
    const screening = await this.screenSubmission({
      userId: from.id,
      data: session.data,
      excludeSubmissionId: guard?.submission_id ?? null,
    });
    if (screening.blocked) {
      return this.sendPreview(session, template, chatId, {
        notice: `${screening.blocked}\n${this.texts('fixHint')}`,
      });
    }

    // 抢锁：并发的第二次点击会在这里被挡住
    const now = nowSeconds();
    let holdsLock;
    if (!guard) {
      holdsLock = await this.store.claimGuard(guardKey, now, now + PUBLISH_LOCK_SECONDS);
      if (!holdsLock) holdsLock = await this.store.lockGuard(guardKey, now, now + PUBLISH_LOCK_SECONDS);
    } else {
      holdsLock = await this.store.lockGuard(guardKey, now, now + PUBLISH_LOCK_SECONDS);
    }
    if (!holdsLock) {
      await this.reply(chatId, this.texts('publishingInProgress'));
      return undefined;
    }

    let submissionId = guard?.submission_id ?? state.submissionId ?? null;
    if (!submissionId) {
      submissionId = await this.store.createSubmission({
        userId: from.id,
        username: from.username ?? null,
        fullName: fullName(from),
        templateId: session.templateId,
        data: this.submissionData(session),
        contentHash: screening.hash,
        flags: screening.flags,
      });
      await this.store.setGuardSubmission(guardKey, submissionId);
    } else {
      // 重试可能带着用户改过的内容，必须同步回数据库，否则撤回重发会发出旧稿
      await this.store.updateSubmissionContent(submissionId, {
        data: this.submissionData(session),
        contentHash: screening.hash,
        flags: screening.flags,
        username: from.username ?? null,
        fullName: fullName(from),
      });
    }
    // 投稿级租约：挡住管理员那边同时在发同一条投稿
    if (!(await this.acquireSubmissionLease(submissionId))) {
      await this.store.releaseGuard(guardKey);
      await this.reply(chatId, this.texts('publishingInProgress'));
      return undefined;
    }
    state.submissionId = submissionId;
    state.phase = 'publishing';
    await this.persistSession(session);

    const submission = {
      id: submissionId,
      userId: from.id,
      username: from.username ?? null,
      fullName: fullName(from),
      templateId: session.templateId,
      data: this.submissionData(session),
      status: 'pending',
      flags: screening.flags,
    };

    let published;
    try {
      published = await this.publish(submission, template, { review });
      await this.store.setGuardStatus(guardKey, review ? 'submitted' : 'published');
      // 审核模式还要等管理员通过，租约必须放开，否则「通过」会被当成"正在发布中"
      await this.releaseSubmissionLease(submissionId, { published: !review });
      if (review) {
        // 送审完成 → 回到"待审核"，而不是停在"发布中"
        await this.store.updateSubmission(submissionId, { status: 'pending' });
      }
    } catch (error) {
      this.logger.error?.('发布投稿失败', error);
      const message = String(error?.message ?? error);
      await this.store.releaseGuard(guardKey);
      await this.releaseSubmissionLease(submissionId);
      await this.store.updateSubmission(submissionId, { status: 'failed' });
      await this.store.audit(from.id, 'submission.publish_failed', 'submission', submissionId, message);
      state.phase = 'failed';
      state.lastError = message;
      // 重试键盘挂在新消息上，promptMessageId 必须跟着走，否则按钮会被当成过期
      const notice = await this.reply(
        chatId,
        this.texts('publishFailedRetry', { error: escapeHtml(truncate(message, 200)) }),
        {
          raw: true,
          keyboard: retryKeyboard(this.texts),
        },
      );
      session.promptChatId = chatId;
      session.promptMessageId = notice?.message_id ?? session.promptMessageId;
      await this.persistSession(session);
      await this.notifyAdmins(
        this.texts('adminPublishFailed', { submission_id: submissionId, error: escapeHtml(message) }),
      );
      return undefined;
    }

    // 到这里投稿已经发出去了，收尾失败不能反过来当成"发布失败"
    await this.finishSession(from.id);

    if (review) {
      await this.reply(chatId, this.texts('submittedPending'), {
        keyboard: await this.menuKeyboard(from.id, { hasSession: false }),
      });
      return undefined;
    }

    const username = await this.ensureTargetChat();
    const link = linkForMessage(published.chatId, published.messageId, username);
    const partial = (published.failures?.length ?? 0) > 0;
    const body = partial
      ? this.texts('submittedPartial')
      : (link
          ? this.texts('submittedPublished', { link, main_group_url: '' })
          : this.texts('submittedNoLink', { main_group_url: '' })
        ).replace(/\n+👥 投稿主群：\s*$/u, '');
    const receipt = await this.reply(chatId, body, {
      keyboard: await this.menuKeyboard(from.id, { hasSession: false }),
    });
    // 记住这条回执：用户直接回复它就能继续和管理员对话
    if (receipt?.message_id) {
      await this.store.rememberThreadMessage(chatId, receipt.message_id, submissionId, 'to_user');
    }
    return undefined;
  }

  /** 真正发到群里的动作（审核模式先发到独立的审核群）。 */
  async publish(submission, template, { review = false, force = false } = {}) {
    const configuredTargets = review
      ? [
          {
            id: null,
            chat_id: await this.effectiveReviewChatId(),
            // 审核群用自己主聊天区；带发布目标的 forum topic 会把审核卡片投到错误话题甚至直接被拒
            thread_id: null,
            title: null,
            username: null,
          },
        ]
      : await this.effectivePublishTargets();
    const targets = configuredTargets.filter((target) => target.chat_id !== null && target.chat_id !== undefined);
    if (targets.length === 0) {
      throw new Error(
        review
          ? '审核模式没有配置独立审核群（ADMIN_CHAT_ID）'
          : '还没有设置投稿发布目标：把我拉进群/频道，然后由 Owner 在目标聊天执行 /bind',
      );
    }

    const attachments = attachmentsOf(submission.data, template);
    let text = composeSubmission(this.config, {
      data: submission.data,
      template,
      submissionId: submission.id,
      user: { fullName: submission.fullName, username: submission.username },
      attachments,
      overrideText: submission.overrideText,
    });
    if (review) {
      const notes = reviewNotes(this.texts, {
        flags: submission.flags ?? [],
        stats: await this.store.userSubmissionStats(submission.userId),
      });
      if (notes.length > 0) text = `${text}\n\n${notes.join('\n')}`;
    }
    // 兜底：模板/页脚写太长时不能把整条投稿卡死
    const textTooLong = text.length > MAX_PUBLISH_TEXT;
    if (textTooLong) {
      this.logger.warn?.(`投稿 #${submission.id} 正文超过 ${MAX_PUBLISH_TEXT} 字，已截断发布`);
      text = fitHtml(text, MAX_PUBLISH_TEXT);
    }

    const keyboard = adminKeyboard(this.texts, submission.id, {
      review,
      commentUrl: review ? null : await this.publicCommentUrl(submission.id),
    });
    // 已经发过的目标：重试时跳过，绝不再发一遍。
    // force=true 用于「撤下后重新发布」：那些消息已经被删掉了，必须重新发。
    const already = force ? new Map() : await this.store.publishedState(submission.id);
    const results = [];
    const failures = [];
    for (const target of targets) {
      const chatId = target.chat_id;
      let threadId = target.thread_id ?? undefined;
      const done = already.get(chatId);
      try {
        if (done?.text) {
          const textId = await this.store.firstPublishedMessageId(submission.id, chatId, 'published_text');
          const mediaId = await this.store.firstPublishedMediaId(submission.id, chatId);
          results.push({
            targetId: target.id,
            chatId,
            messageId: textId,
            messageIds: [textId].filter(Boolean),
            mediaMessageId: mediaId,
            skipped: true,
          });
          continue;
        }

        // 已经发出去的媒体条数（失败重试时从这里续传）
        const countSent = async () =>
          (await this.store.listPublishedMessageIdsForChat(submission.id, chatId, 'published_media')).length;
        let mediaIds = await this.store.listPublishedMessageIdsForChat(submission.id, chatId, 'published_media');

        if (attachments.length > 0) {
          const attachmentCaption = fitHtml(
            mediaCaption(this.config, { data: submission.data, template, attachments }),
            MAX_CAPTION,
          );
          const mediaResult = await this.sendPublishAttachments(chatId, target, attachments, {
            caption: attachmentCaption,
            threadId,
            countSent,
            // 每发完一批就落库：中途失败也不会让已经发出去的消息变成"无主"而被重发
            onBatch: async (ids) => {
              await this.recordPublished(submission.id, chatId, ids, 'published_media');
              if (target.id) {
                const soFar = await this.store.listPublishedMessageIdsForChat(submission.id, chatId, 'published_media');
                await this.store.saveSubmissionTargetMessages(submission.id, target.id, soFar);
              }
            },
          });
          threadId = mediaResult.threadId;
          mediaIds = await this.store.listPublishedMessageIdsForChat(submission.id, chatId, 'published_media');
        }

        const message = await this.sendPublishMessage(chatId, target, text, {
          keyboard,
          threadId,
          replyTo: mediaIds[0],
        });
        await this.recordPublished(submission.id, chatId, [message.message_id], 'published_text');
        const messageIds = [...mediaIds, message.message_id];
        if (target.id) await this.store.saveSubmissionTargetMessages(submission.id, target.id, messageIds);
        results.push({
          targetId: target.id,
          chatId,
          messageId: message.message_id,
          messageIds,
          mediaMessageId: mediaIds[0] ?? null,
        });
      } catch (error) {
        failures.push({ target, error });
        this.logger.error?.(`发布到 ${chatId} 失败：${error?.message ?? error}`);
      }
    }
    if (results.length === 0) {
      throw new Error(
        failures.map(({ target, error }) => `${target.title || target.chat_id}: ${error?.message ?? error}`).join('；'),
      );
    }

    const primary = results[0];
    const patch = {
      publish_chat_id: primary.chatId,
      publish_message_id: primary.messageId,
      media_chat_id: primary.mediaMessageId ? primary.chatId : null,
      media_message_id: primary.mediaMessageId,
      message_ids: JSON.stringify(primary.messageIds),
    };
    // 只有全部目标都成功才算发布完成；部分失败留给调用方标成可恢复状态
    if (!review && failures.length === 0) {
      patch.status = 'published';
      patch.published_at = Math.floor(Date.now() / 1000);
    }
    await this.store.updateSubmission(submission.id, patch);
    if (failures.length > 0) {
      const detail = failures
        .map(({ target, error }) => `${target.title || target.chat_id}：${error?.message ?? error}`)
        .join('；');
      await this.notifyAdmins(`⚠️ 投稿 #${submission.id} 部分发布失败：${detail}`);
      // 抛给调用方：用户看到「重试」按钮，重试会跳过已经发成功的目标
      const error = new Error(`部分目标发布失败：${detail}`);
      error.partial = true;
      error.published = { ...primary, targets: results, failures };
      throw error;
    }
    return { ...primary, targets: results, failures };
  }

  /**
   * 记录「这条消息属于哪条投稿」。
   * 相册的第 2..N 条、多目标的每一条都会记下来，这样在任意一条下面回复都能关联到投稿。
   */
  async recordPublished(submissionId, chatId, messageIds, direction) {
    for (const messageId of messageIds ?? []) {
      if (!messageId) continue;
      await this.store.rememberThreadMessage(chatId, messageId, submissionId, direction);
    }
  }

  // ------------------------------------------------------------------
  // 按钮回调
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 防滥用
  // ------------------------------------------------------------------

  /** 投稿前检查：敏感词 / 链接 / 重复内容 / 新用户冷却。 */
  async screenSubmission({ userId, data, excludeSubmissionId = null }) {
    const { options } = this.config;
    const plain = [textOf(data.title), textOf(data.body), textOf(data.signature), textOf(data.contact)]
      .filter(Boolean)
      .join('\n');
    const flags = [];
    const lower = plain.toLowerCase();
    for (const word of options.bannedWords) {
      if (word && lower.includes(word.toLowerCase())) flags.push(`word:${word}`);
    }
    if (options.blockLinks && LINK_PATTERN.test(plain)) flags.push('link');

    // 命中敏感词/链接：审核模式下交给管理员判断，否则直接拦下
    if (flags.length > 0 && !(await this.isReviewMode())) {
      const first = flags[0];
      const blocked = first.startsWith('word:')
        ? this.texts('blockedWord', { word: first.slice(5) })
        : this.texts('blockedLink');
      return { blocked, flags, hash: null };
    }

    const hash = fingerprint(plain);
    if (options.duplicateWindowSeconds > 0) {
      const same = await this.store.countSameContent(userId, hash, options.duplicateWindowSeconds, excludeSubmissionId);
      if (same > 0) return { blocked: this.texts('duplicateBlocked'), flags, hash };
    }

    if (options.newUserCooldownSeconds > 0) {
      const profile = await this.store.getUserProfile(userId);
      if (profile) {
        const waited = nowSeconds() - profile.first_seen;
        if (waited < options.newUserCooldownSeconds) {
          return {
            blocked: this.texts('cooldownWait', { seconds: options.newUserCooldownSeconds - waited }),
            flags,
            hash,
          };
        }
      }
    }
    return { blocked: null, flags, hash };
  }

  // ------------------------------------------------------------------
  // 匿名双向对话
  // ------------------------------------------------------------------

  /** 一条投稿在群里的"对话锚点"：接着聊时挂在哪条消息下面。 */
  async threadAnchor(submission) {
    if (!submission.publishChatId) return null;
    const recalled = ['recalled', 'deleted'].includes(submission.status);
    // 锚点要落在"这条投稿实际发布"的那个话题里：多目标时不能拿 targets[0] 的话题去套。
    const target = await this.store.getPublishTargetByChat(submission.publishChatId);
    const threadId = target ? target.thread_id : await this.effectiveThreadId();
    return {
      chatId: submission.publishChatId,
      messageId: recalled ? null : submission.publishMessageId,
      threadId: threadId ?? undefined,
    };
  }

  /** 管理员的话 → 投稿者私聊；同时记下来，方便对方直接回复继续聊。 */
  async deliverToUser(submission, text) {
    if (!this.canNotifyAuthor(submission)) return this.deliverToWebAuthor(submission, text);
    const body = `${text}\n\n<i>${escapeHtml(this.texts('threadHint'))}</i>`;
    const sent = await this.tryReply(submission.userId, body, {
      raw: true,
      keyboard: threadUserKeyboard(this.texts, submission.id),
    });
    if (sent) {
      await this.store.rememberThreadMessage(submission.userId, sent.message_id, submission.id, 'to_user');
    }
    return sent;
  }

  /** 用户是不是在跟某条投稿对话（回复对话消息，或点了「接着说」/「回复评论」）。 */
  async handleThreadReply(message, from, chatId) {
    const replyTo = message.reply_to_message;
    const pending = await this.store.getAdminAction(from.id);

    // 通过「💬 评论」深链进来的：下一条消息就是公开评论（内容不合格时保留动作，让他重写）
    if (pending?.action?.startsWith('public_comment:')) {
      const submissionId = Number.parseInt(String(pending.action).split(':')[1] ?? '', 10);
      return this.postPublicComment(submissionId, message, from, chatId);
    }
    // 「回复评论」优先：作者刚点过按钮，下一条消息就是要发到评论区的
    if (pending?.action?.startsWith('comment_reply')) {
      const [, rawChat, rawMessage] = String(pending.action).split(':');
      return this.postCommentReply(pending.submissionId, message, from, chatId, {
        chatId: Number.parseInt(rawChat ?? '', 10),
        messageId: Number.parseInt(rawMessage ?? '', 10),
      });
    }

    let submissionId = null;
    if (replyTo) {
      submissionId = await this.store.findSubmissionByMessage(chatId, replyTo.message_id);
    }
    if (!submissionId && pending?.action === 'user_tell') {
      submissionId = pending.submissionId;
      await this.store.clearAdminAction(from.id);
    }
    if (!submissionId) return false;

    const submission = await this.store.getSubmission(submissionId);
    if (!submission) {
      await this.reply(chatId, this.texts('threadClosed'));
      return true;
    }
    const text = (message.text ?? message.caption ?? '').trim();
    const attachment = extractAttachment(message);
    await this.forwardUserFollowUp(submission, { text, attachment, messageId: message.message_id, chatId });
    return true;
  }

  /** 投稿者的补充 → 群里原投稿下面（管理员可以在那条消息上直接回复）。 */
  async forwardUserFollowUp(submission, { text, attachment, messageId, chatId }) {
    const anchor = await this.threadAnchor(submission);
    if (!anchor) {
      await this.reply(chatId, this.texts('threadClosed'));
      return;
    }
    const body = text || '（附件）';
    const sent = await this.tg.sendMessage(
      anchor.chatId,
      this.texts('threadUserMessage', { submission_id: submission.id, text: escapeHtml(body) }),
      {
        keyboard: threadAdminKeyboard(this.texts, submission.id),
        threadId: anchor.threadId,
        replyTo: anchor.messageId,
      },
    );
    await this.store.rememberThreadMessage(anchor.chatId, sent.message_id, submission.id, 'to_admin');

    if (attachment?.fileId) {
      const extra = await this.sendAttachment(anchor.chatId, attachment, { threadId: anchor.threadId });
      if (extra?.message_id) {
        await this.store.rememberThreadMessage(anchor.chatId, extra.message_id, submission.id, 'to_admin');
      }
    }
    await this.tryReact(chatId, messageId, '✅');
  }

  // ------------------------------------------------------------------
  // 附件发送
  // ------------------------------------------------------------------

  /** 发布专用：目标话题关闭后退回主聊天；若 General 也关闭则尝试自动重开。 */
  /**
   * 话题被关闭（TOPIC_CLOSED）时的回退。
   *
   * 这里**不再**把目标的 thread_id 清成 null：那样"话题被关过一次"就会永久退化成发主聊天，
   * 而且没有任何提示（之前线上就是这样，投稿全掉进 General 再也不回话题）。
   * 现在的策略：
   *   1) 先尝试重开原话题（需要机器人有「管理话题」权限）——成功就继续发在原话题；
   *   2) 重开不了就**只把这一条**发到主聊天，绑定保持不动，下次仍然会尝试发回话题；
   *   3) 两种情况都按节流提醒管理员（同一个话题一小时最多一次）。
   * 返回这次发布应该使用的 threadId（undefined = 主聊天/General）。
   */
  async publishTopicFallback(chatId, target, threadId) {
    if (threadId !== undefined && threadId !== null) {
      const noticeKey = `topic:${chatId}:${threadId}`;
      try {
        await this.tg.reopenForumTopic(chatId, threadId);
        await this.notifyAdminsOnce(noticeKey, this.texts('topicClosedRecovered', { thread_id: threadId }));
        return threadId;
      } catch (error) {
        this.logger.warn?.(`重开话题 ${threadId} 失败：${error?.message ?? error}`);
        await this.notifyAdminsOnce(noticeKey, this.texts('topicClosedFellBack', { thread_id: threadId }));
        return undefined;
      }
    }

    // 没指定话题时，Telegram 会把论坛群消息放到 General；General 也可能被关闭。
    // reopenGeneralForumTopic 要求机器人是管理员且拥有「管理话题」权限。
    try {
      await this.tg.reopenGeneralForumTopic(chatId);
      return undefined;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/CHAT_ADMIN_REQUIRED/i.test(message)) {
        throw new Error(this.texts('topicClosedGeneral'), { cause: error });
      }
      throw error;
    }
  }

  /** 同一件事在冷却期内只提醒管理员一次，避免每次失败都刷他们的私聊。 */
  async notifyAdminsOnce(key, text, cooldownSeconds = 3600) {
    const settingKey = `notice:${key}`;
    const last = Number.parseInt((await this.store.getSetting(settingKey)) ?? '0', 10) || 0;
    const now = nowSeconds();
    if (last > 0 && now - last < cooldownSeconds) return false;
    await this.store.setSetting(settingKey, String(now));
    await this.notifyAdmins(text);
    return true;
  }

  /**
   * 把附件排成确定性的发送批次：图片/视频按最多 10 个成组，其余单个。
   * 批次是"全成功或全失败"的原子单位，所以可以按批记录、按批续传。
   */
  attachmentBatches(attachments) {
    const batches = [];
    let group = [];
    const flush = () => {
      for (const piece of chunk(group, MAX_MEDIA_GROUP)) batches.push({ type: 'media', items: piece });
      group = [];
    };
    for (const attachment of attachments ?? []) {
      if (attachment.kind === 'photo' || attachment.kind === 'video') {
        group.push(attachment);
        continue;
      }
      flush();
      batches.push({ type: 'single', items: [attachment] });
    }
    flush();
    return batches;
  }

  /**
   * 按批次发送附件，并在每批成功后立刻回调记录消息 id。
   * `skipMessages` 之前已经发出去的消息会被跳过（失败重试用，绝不重复发）。
   */
  async sendAttachmentBatches(chatId, batches, { caption, threadId, skipMessages = 0, onBatch } = {}) {
    const messages = [];
    let produced = 0;
    let captionUsed = skipMessages > 0;

    for (const batch of batches) {
      if (produced + batch.items.length <= skipMessages) {
        produced += batch.items.length;
        continue;
      }
      const batchCaption = captionUsed ? undefined : caption;
      let sent;
      if (batch.type === 'media' && batch.items.length > 1) {
        sent = await this.tg.sendMediaGroup(
          chatId,
          batch.items.map((item) => ({ type: item.kind, media: item.fileId })),
          { caption: batchCaption, threadId },
        );
      } else {
        const single = await this.sendAttachment(chatId, batch.items[0], { caption: batchCaption, threadId });
        sent = single ? [single] : [];
      }
      const ids = (sent ?? []).map((message) => message?.message_id).filter(Boolean);
      messages.push(...ids);
      produced += batch.items.length;
      captionUsed = true;
      if (onBatch && ids.length > 0) await onBatch(ids);
    }
    return messages;
  }

  /** 兼容旧调用：一次性发完，不做记录（确认页预览用）。 */
  async sendAttachments(chatId, attachments, { caption, threadId } = {}) {
    return this.sendAttachmentBatches(chatId, this.attachmentBatches(attachments), { caption, threadId });
  }

  /**
   * 发布专用：目标话题关闭时回退主聊天。
   * 每次尝试都重新数一遍"已经发出去几条"，所以回退重试也不会重复发。
   */
  async sendPublishAttachments(chatId, target, attachments, { caption, threadId, onBatch, countSent } = {}) {
    const batches = this.attachmentBatches(attachments);
    const attempt = async (tid) => {
      const skipMessages = countSent ? await countSent() : 0;
      return this.sendAttachmentBatches(chatId, batches, { caption, threadId: tid, skipMessages, onBatch });
    };
    const { result, threadId: usedThreadId } = await this.sendWithTopicFallback(attempt, chatId, target, threadId);
    return { messages: result, threadId: usedThreadId };
  }

  async sendPublishMessage(chatId, target, text, { keyboard, threadId, replyTo } = {}) {
    const attempt = (tid) => this.tg.sendMessage(chatId, text, { keyboard, threadId: tid, replyTo });
    const { result } = await this.sendWithTopicFallback(attempt, chatId, target, threadId);
    return result;
  }

  /**
   * 发一条消息或一批媒体，遇到 TOPIC_CLOSED 时回退重试（最多两轮，避免打转）。
   * 返回实际生效的 threadId：正文必须跟着媒体的落点走，否则正文和图片会被拆到两个话题里。
   */
  async sendWithTopicFallback(attempt, chatId, target, threadId) {
    let currentThreadId = threadId ?? undefined;
    let lastError;
    for (let round = 0; round < 2; round += 1) {
      try {
        return { result: await attempt(currentThreadId), threadId: currentThreadId };
      } catch (error) {
        if (!isTopicClosedError(error)) throw error;
        lastError = error;
        currentThreadId = await this.publishTopicFallback(chatId, target, currentThreadId);
      }
    }
    throw lastError;
  }

  async sendAttachment(chatId, attachment, { caption, threadId } = {}) {
    switch (attachment.kind) {
      case 'photo':
        return this.tg.sendPhoto(chatId, attachment.fileId, { caption, threadId });
      case 'video':
        return this.tg.sendVideo(chatId, attachment.fileId, { caption, threadId });
      case 'document':
        return this.tg.sendDocument(chatId, attachment.fileId, { caption, threadId });
      case 'audio':
        return this.tg.sendAudio(chatId, attachment.fileId, { caption, threadId });
      case 'voice':
        return this.tg.sendVoice(chatId, attachment.fileId, { caption, threadId });
      case 'poll':
        return this.tg.sendPoll(
          chatId,
          attachment.poll?.question ?? '投票',
          (attachment.poll?.options ?? []).slice(0, 10),
          { threadId },
        );
      case 'location':
        return this.tg.sendLocation(chatId, attachment.latitude, attachment.longitude, { threadId });
      default:
        return null;
    }
  }

  async publishTargetsMenu(chatId, userId) {
    if (!(await this.canManageAdmins(userId))) return this.reply(chatId, this.texts('ownerOnly'));
    const targets = await this.store.listPublishTargets();
    const lines =
      targets.length === 0
        ? '📭 还没有授权发布目标。\n\n把机器人拉进群/频道后，在目标聊天执行 /bind（必须由 Owner 操作）。'
        : targets
            .map((target, i) => {
              const state = Number(target.enabled) ? '✅' : '⏸️';
              const topic = target.thread_id ? ` · 话题 ${target.thread_id}` : ' · 主聊天';
              return `${i + 1}. ${state} ${escapeHtml(target.title || target.username || String(target.chat_id))}${escapeHtml(topic)}`;
            })
            .join('\n');
    return this.reply(
      chatId,
      `📮 发布目标\n\n已授权：${targets.length} 个 · 启用：${targets.filter((item) => Number(item.enabled)).length}/${targets.length} 启用\n\n${lines}\n\n` +
        `点击目标可切换启用状态；删除会要求二次确认。\n` +
        `📍 改发布话题：进那个群里想发布的话题发一次 /topic（在群主聊天区发 /topic off 回到主聊天）。`,
      {
        keyboard: publishTargetsKeyboard(this.texts, targets),
        raw: true,
      },
    );
  }

  async handlePublishTargetCallback(query, data) {
    const from = query.from;
    if (!(await this.canManageAdmins(from.id)))
      return this.answer(query.id, { text: this.texts('ownerOnly'), showAlert: true });
    const [, action, rawId] = data.split(':');
    if (action === 'none') return this.answer(query.id);
    if (action === 'cancel') {
      await this.answer(query.id);
      return this.publishTargetsMenu(query.message?.chat?.id ?? from.id, from.id);
    }
    const id = Number.parseInt(rawId ?? '', 10);
    if (!Number.isFinite(id)) return this.answer(query.id, { text: '目标无效', showAlert: true });
    const target = await this.store.getPublishTarget(id);
    if (!target) return this.answer(query.id, { text: '目标不存在', showAlert: true });
    if (action === 'toggle') {
      const enabled = !Number(target.enabled);
      await this.store.setPublishTargetEnabled(id, enabled);
      await this.store.audit(
        from.id,
        enabled ? 'publish_target.enable' : 'publish_target.disable',
        'publish_target',
        id,
        String(target.chat_id),
      );
      await this.answer(query.id, { text: enabled ? '已启用发布目标' : '已停用发布目标' });
      return this.publishTargetsMenu(query.message?.chat?.id ?? from.id, from.id);
    }
    if (action === 'delete') {
      await this.answer(query.id);
      return this.tryEditMarkup(
        query.message?.chat?.id,
        query.message?.message_id,
        `⚠️ 确定删除发布目标「${escapeHtml(target.title || target.username || target.chat_id)}」？\n\n删除后机器人将不再向这里发布。`,
        { keyboard: publishTargetDeleteKeyboard(target) },
      );
    }
    if (action === 'confirm_delete') {
      await this.store.deletePublishTarget(id);
      await this.store.audit(from.id, 'publish_target.delete', 'publish_target', id, String(target.chat_id));
      await this.answer(query.id, { text: '已删除' });
      return this.publishTargetsMenu(query.message?.chat?.id ?? from.id, from.id);
    }
    return this.answer(query.id);
  }

  async handleCallbackQuery(query) {
    const from = query.from;
    if (!from || from.is_bot) return undefined;
    const data = query.data ?? '';
    const [scope] = data.split(':');
    if (scope === 't') return this.handlePublishTargetCallback(query, data);
    if (scope === 'a') return this.handleAdminCallback(query, data);
    if (scope !== 'w') return this.answer(query.id);
    return this.handleWizardCallback(query, data);
  }

  async handleWizardCallback(query, data) {
    const [, action, ...rest] = data.split(':');
    const from = query.from;
    const chatId = query.message?.chat?.id ?? from.id;
    const messageId = query.message?.message_id ?? null;

    if (action === 'help') {
      await this.answer(query.id);
      return this.reply(
        chatId,
        this.texts('help', { max_photos: this.config.options.maxPhotos }) +
          (this.config.admins.includes(from.id) ? `\n\n${this.texts('adminPanel')}` : ''),
      );
    }
    if (action === 'cancel') {
      await this.answer(query.id);
      return this.onCancel(chatId, from, true);
    }
    if (action === 'start') {
      await this.answer(query.id);
      return this.startWizard(chatId, from, rest[0], { restart: false });
    }
    if (action === 'restart') {
      await this.answer(query.id);
      await this.finishSession(from.id);
      return this.startWizard(chatId, from, rest[0], { restart: true });
    }
    // 新建一份投稿：当前这份会被挂起成草稿，而不是被销毁
    if (action === 'new') {
      await this.answer(query.id);
      const parked = await this.parkActiveDraft(from.id);
      if (parked) {
        const note =
          parked.dropped > 0
            ? `${this.texts('draftSaved')}\n${this.texts('draftLimitDropped', { max: this.config.options.maxDrafts })}`
            : this.texts('draftSaved');
        await this.tryReply(chatId, note, { raw: true });
      }
      const entries = Object.entries(this.config.templates);
      // 多模板时先让用户选新投稿的类型（当前这份已经挂起，放弃选择也不会丢）
      if (entries.length > 1 && !rest[0]) {
        return this.reply(chatId, this.texts('chooseNewTemplate'), {
          keyboard: templateChoiceKeyboard(this.texts, entries),
        });
      }
      return this.startWizard(chatId, from, entries.length > 1 ? rest[0] : entries[0][0], { restart: true });
    }
    if (action === 'my') {
      await this.answer(query.id);
      return this.userHistory(chatId, from.id);
    }
    if (action === 'drafts') {
      await this.answer(query.id);
      return this.showDrafts(chatId, from.id, { query });
    }
    if (action === 'dopen') {
      const draftId = Number.parseInt(rest[0] ?? '', 10);
      const session = Number.isFinite(draftId) ? await this.resumeDraft(from.id, draftId, chatId) : null;
      if (!session) {
        await this.answer(query.id, { text: this.texts('draftNotFound'), showAlert: true });
        return undefined;
      }
      await this.answer(query.id);
      await this.hydrateSessionMedia(session);
      const template = this.config.templates[session.templateId];
      return this.showSession(session, template, chatId, { notice: this.texts('draftResumed') });
    }
    if (action === 'ddel') {
      const draftId = Number.parseInt(rest[0] ?? '', 10);
      const ok = Number.isFinite(draftId) ? await this.store.deleteDraft(from.id, draftId) : false;
      await this.answer(query.id, { text: ok ? this.texts('draftDeleted') : this.texts('draftNotFound') });
      return this.showDrafts(chatId, from.id, { query });
    }
    if (action === 'dback') {
      await this.answer(query.id);
      return this.reply(chatId, this.texts('menu'), { keyboard: await this.menuKeyboard(from.id) });
    }
    // 多模板下"新建投稿"选类型时反悔：把刚挂起的那份直接恢复回来
    if (action === 'newback') {
      await this.answer(query.id);
      const newest = await this.store.listDrafts(from.id, 1);
      if (newest.length === 0) {
        return this.reply(chatId, this.texts('nothingToCancel'), { keyboard: await this.menuKeyboard(from.id) });
      }
      const session = await this.resumeDraft(from.id, newest[0].id, chatId);
      if (!session) {
        await this.tryReply(chatId, this.texts('draftNotFound'));
        return undefined;
      }
      await this.hydrateSessionMedia(session);
      return this.showSession(session, this.config.templates[session.templateId], chatId, {
        notice: this.texts('draftResumed'),
      });
    }
    // 「接着说」不需要有进行中的投稿，只要之前投过稿就行
    if (action === 'tell') {
      const submissionId = Number.parseInt(rest[0] ?? '', 10);
      if (!Number.isFinite(submissionId)) {
        await this.answer(query.id, { text: this.texts('threadClosed'), showAlert: true });
        return undefined;
      }
      await this.answer(query.id);
      await this.store.setAdminAction(from.id, 'user_tell', submissionId);
      return this.reply(chatId, this.texts('threadButtonPrompt'));
    }
    if (action === 'noop') return this.answer(query.id);

    // 「回复评论」：下一条消息发到官方评论区（可以指定回复哪一条）
    if (action === 'creply') {
      const submissionId = Number.parseInt(rest[0] ?? '', 10);
      const targetChatId = Number.parseInt(rest[1] ?? '', 10);
      const targetMessageId = Number.parseInt(rest[2] ?? '', 10);
      if (!Number.isFinite(submissionId)) {
        await this.answer(query.id, { text: this.texts('threadClosed'), showAlert: true });
        return undefined;
      }
      const comment =
        Number.isFinite(targetChatId) && Number.isFinite(targetMessageId)
          ? await this.store.getComment(targetChatId, targetMessageId)
          : await this.store.latestComment(submissionId);
      if (!comment) {
        await this.answer(query.id, { text: this.texts('commentReplyNone'), showAlert: true });
        return undefined;
      }
      await this.answer(query.id);
      await this.store.setAdminAction(from.id, `comment_reply:${comment.chat_id}:${comment.message_id}`, submissionId);
      return this.reply(
        chatId,
        this.texts('commentReplyPromptQuote', {
          name: escapeHtml(comment.author_name || '有人'),
          text: escapeHtml(truncate(comment.text || '（附件）', 120)),
        }),
        { raw: true },
      );
    }
    // 作者查看某条投稿的全部评论（分页，每条一个回复按钮）
    if (action === 'clist') {
      const submissionId = Number.parseInt(rest[0] ?? '', 10);
      const offset = Number.parseInt(rest[1] ?? '0', 10);
      await this.answer(query.id);
      return this.showAuthorComments(chatId, from.id, submissionId, Number.isFinite(offset) ? offset : 0);
    }

    // 以下都需要有效的进行中会话
    const session = await this.loadSession(from.id);
    if (!session) {
      await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
      return undefined;
    }
    await this.hydrateSessionMedia(session);
    const template = this.config.templates[session.templateId];
    const state = this.sessionState(session);

    // 按钮必须来自「当前这条提示消息」：点过修改后再点旧确认页的确认会被拒绝，
    // 不会把只有一半内容的投稿发出去。
    if (session.promptMessageId && messageId && Number(messageId) !== Number(session.promptMessageId)) {
      await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
      return undefined;
    }

    if (action === 'cap') return this.checkCaptcha(query, session, chatId, rest[0]);

    if (action === 'confirm' || action === 'retry') {
      const phase = state.phase ?? (session.stepId ? 'collecting' : 'preview');
      const allowed = action === 'confirm' ? phase === 'preview' : phase === 'failed';
      if (session.stepId || !allowed) {
        await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
        return undefined;
      }
      await this.answer(query.id);
      // 先把确认页改成「正在发布」，避免用户对着没反应的界面反复点
      await this.tryEditMarkup(chatId, session.promptMessageId, this.texts('publishing'), { removeKeyboard: true });
      return this.submit(session, from, chatId, template);
    }

    if (action === 'edit') return this.sendEditMenu(session, template, chatId, { query });

    if (action === 'preview') {
      await this.answer(query.id);
      return this.sendPreview(session, template, chatId);
    }

    if (action === 'media') {
      const fromStep = Boolean(rest[0]);
      const stepId = rest[0] ?? state.mediaStepId ?? this.defaultMediaStep(template);
      if (!stepId) {
        await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
        return undefined;
      }
      await this.answer(query.id);
      return this.sendMediaManager(session, template, chatId, stepId, {
        query,
        from: fromStep ? 'step' : 'preview',
      });
    }
    if (action === 'mm') return this.onMediaAction(query, session, template, chatId, rest);
    if (action === 'mclear') {
      const stepId = rest[0];
      await this.store.clearSessionMedia(from.id, stepId);
      await this.hydrateSessionMedia(session);
      await this.answer(query.id, { text: this.texts('mediaCleared') });
      return this.sendMediaManager(session, template, chatId, stepId, { query, from: state.mediaFrom ?? 'step' });
    }
    if (action === 'mback') {
      const stepId = rest[0];
      await this.answer(query.id);
      if ((state.mediaFrom ?? 'step') === 'preview') return this.sendPreview(session, template, chatId);
      session.stepId = stepId;
      await this.persistSession(session);
      return this.sendPrompt(session, template, chatId);
    }
    if (action === 'goto') {
      const stepId = rest[0];
      const target = visibleSteps(template, session.data).find((item) => item.id === stepId);
      if (!target) {
        await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
        return undefined;
      }
      await this.answer(query.id);
      state.editing = true;
      session.stepId = target.id;
      await this.persistSession(session);
      return this.sendPrompt(session, template, chatId, { notice: this.texts('editBackHint') });
    }
    if (action === 'back') {
      const steps = visibleSteps(template, session.data);
      const fromStepId = rest[0];
      const cameFromPreview = !session.stepId;
      const target = fromStepId ? previousStep(template, session.data, fromStepId) : (steps[steps.length - 1] ?? null);
      if (!target) {
        await this.answer(query.id, { text: this.texts('alreadyFirstStep') });
        return undefined;
      }
      await this.answer(query.id);
      // 从确认页返回：改完这一项自动回确认页；流程中途返回：保持原来的前进语义
      if (cameFromPreview) state.editing = true;
      session.stepId = target.id;
      await this.persistSession(session);
      return this.sendPrompt(session, template, chatId, { notice: this.texts('backHint') });
    }

    const stepId = rest[0];
    if (!stepId || session.stepId !== stepId) {
      await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
      return undefined;
    }
    const step = findStep(template, stepId);
    if (!step) {
      await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
      return undefined;
    }

    switch (action) {
      case 'opt': {
        const index = Number.parseInt(rest[1] ?? '', 10);
        const option = step.options?.[index];
        if (option === undefined) {
          await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
          return undefined;
        }
        await this.answer(query.id, { text: String(option) });
        await this.recordAnswer(session, step, String(option));
        return this.advance(session, template, chatId);
      }
      case 'skip': {
        if (step.required !== false) {
          await this.answer(query.id, { text: this.texts('stepRequired'), showAlert: true });
          return undefined;
        }
        await this.answer(query.id);
        await this.recordAnswer(session, step, step.type === 'media' ? [] : null);
        return this.advance(session, template, chatId);
      }
      case 'done': {
        await this.answer(query.id);
        await this.recordAnswer(session, step, session.data[step.id] ?? []);
        return this.advance(session, template, chatId);
      }
      default:
        return this.answer(query.id);
    }
  }

  /** 真人验证的按钮回调。 */
  async checkCaptcha(query, session, chatId, rawIndex) {
    const captcha = session.data.__captcha;
    const index = Number.parseInt(rawIndex ?? '', 10);
    if (!captcha) {
      await this.answer(query.id, { text: this.texts('expiredChoice'), showAlert: true });
      return undefined;
    }
    if (index === captcha.targetIndex) {
      delete session.data.__captcha;
      await this.answer(query.id, { text: '✅' });
      const template = this.config.templates[session.templateId];
      const step = firstStep(template, session.data);
      session.stepId = step?.id ?? null;
      await this.persistSession(session);
      await this.tryEditMarkup(session.promptChatId, session.promptMessageId, '✅ 验证通过', {
        removeKeyboard: true,
      });
      if (!step) return this.sendPreview(session, template, chatId);
      return this.sendPrompt(session, template, chatId, { notice: template.welcome });
    }

    captcha.tries += 1;
    if (captcha.tries >= CAPTCHA_MAX_TRIES) {
      await this.finishSession(session.userId);
      await this.answer(query.id, { text: this.texts('captchaFailed'), showAlert: true });
      return this.reply(chatId, this.texts('captchaFailed'), {
        keyboard: await this.menuKeyboard(session.userId, { hasSession: false }),
      });
    }
    const remaining = Math.max(0, CAPTCHA_MAX_TRIES - captcha.tries);
    const notice = this.texts('captchaWrong', { remaining });
    await this.answer(query.id, { text: notice, showAlert: true });
    // 点错就换一道题：内容和按钮一起改，聊天里不会堆一串失败记录
    return this.rerollCaptcha(session, chatId, { notice });
  }

  // ------------------------------------------------------------------
  // 管理面板（按钮化）
  // ------------------------------------------------------------------

  /** 打开管理面板（新消息）。 */
  async showAdminPanel(chatId) {
    const pending = (await this.store.listPending(200)).length;
    return this.reply(chatId, `${this.texts('panelTitle')}\n\n${this.texts('panelHint')}`, {
      raw: true,
      keyboard: adminPanelKeyboard(this.texts, { pending }),
    });
  }

  /** 面板按钮分发：所有内容都原地替换面板那条消息，带「返回面板」。 */
  async handleAdminPanel(query, key) {
    const chatId = query.message?.chat?.id ?? query.from.id;
    const messageId = query.message?.message_id;
    const role = await this.adminRole(query.from.id);
    const owner = role === 'owner';
    if (!role) return this.answer(query.id, { text: this.texts('adminOnly'), showAlert: true });
    if (['settings', 'targets', 'admins'].includes(key) && !owner) {
      return this.answer(query.id, { text: this.texts('ownerOnly'), showAlert: true });
    }
    await this.answer(query.id);

    const back = () => singleButtonKeyboard(this.texts, 'btnPanelHome', 'a:p:home');
    const show = (text, keyboard = back()) => this.tryEditMarkup(chatId, messageId, text, { keyboard });

    switch (key) {
      case 'pending':
        return this.showPendingQueue(chatId, messageId);
      case 'comments':
        return this.showCommentsPanel(chatId, messageId);
      case 'stats': {
        const stats = await this.store.stats();
        const pending = (await this.store.listPending(200)).length;
        return show(`${this.texts('adminStats', stats)}\n\n${this.texts('panelPendingTitle', { total: pending })}`);
      }
      case 'bans': {
        const bans = await this.store.listBans(20);
        return show(
          bans.length === 0
            ? this.texts('adminBanlistEmpty')
            : this.texts('adminBanlist', {
                items: bans
                  .map((row) => `• <code>${row.user_id}</code>${row.reason ? ` · ${escapeHtml(row.reason)}` : ''}`)
                  .join('\n'),
              }),
        );
      }
      case 'audit': {
        const rows = await this.store.listAudit(15);
        return show(
          rows.length === 0
            ? this.texts('auditEmpty')
            : `${this.texts('auditTitle')}\n\n${rows
                .map(
                  (row) =>
                    `• ${row.id} · <code>${row.actor_id}</code> · ${escapeHtml(row.action)} · ${escapeHtml(row.target_id ?? '—')}`,
                )
                .join('\n')}`,
        );
      }
      case 'admins': {
        const rows = await this.store.listAdmins();
        return show(
          rows.length === 0
            ? this.texts('adminsEmpty')
            : `${this.texts('adminsTitle')}\n\n${rows
                .map((row) => `• <code>${row.user_id}</code> · ${escapeHtml(this.adminRoleLabel(row.role))}`)
                .join('\n')}\n\n${this.texts('adminsUsage')}`,
        );
      }
      case 'settings':
        return show(await this.buildSettingsText());
      case 'targets': {
        const targets = await this.store.listPublishTargets();
        const lines =
          targets.length === 0
            ? this.texts('settingsSourceNone')
            : targets
                .map(
                  (item, index) =>
                    `${index + 1}. ${Number(item.enabled) ? '✅' : '⏸️'} ${escapeHtml(
                      item.title || item.username || String(item.chat_id),
                    )}${item.thread_id ? ` · 话题 ${item.thread_id}` : ''}`,
                )
                .join('\n');
        return show(`📮 发布目标\n\n${lines}\n\n${this.texts('bindHint')}`);
      }
      case 'diag':
        return this.tryEditMarkup(chatId, messageId, await this.diagnoseCommentsText(), {
          keyboard: this.diagKeyboard(chatId),
        });
      case 'help':
        return show(this.texts('adminPanel'));
      default: {
        const pending = (await this.store.listPending(200)).length;
        return this.tryEditMarkup(chatId, messageId, `${this.texts('panelTitle')}\n\n${this.texts('panelHint')}`, {
          keyboard: adminPanelKeyboard(this.texts, { pending }),
        });
      }
    }
  }

  /** 待审队列：每条一个预览按钮。 */
  async showPendingQueue(chatId, messageId) {
    const pending = await this.store.listPending(8);
    const total = (await this.store.listPending(200)).length;
    const back = singleButtonKeyboard(this.texts, 'btnPanelHome', 'a:p:home');
    if (total === 0) return this.tryEditMarkup(chatId, messageId, this.texts('panelPendingEmpty'), { keyboard: back });

    const items = pending.map((row) => ({
      id: row.id,
      userId: row.userId,
      fullName: row.fullName,
      username: row.username,
      preview: truncate(textOf(row.data.body), 40).replace(/\n/g, ' '),
    }));
    const more = total > items.length ? `\n${this.texts('panelPendingMore', { shown: items.length })}` : '';
    const text = `${this.texts('panelPendingTitle', { total })}\n\n${this.texts('panelPendingHint')}${more}`;
    return this.tryEditMarkup(chatId, messageId, text, { keyboard: pendingQueueKeyboard(this.texts, items) });
  }

  /** 队列里的单条预览卡片：直接带通过/拒绝/编辑/回复/拉黑。 */
  async showPendingCard(query, submissionId) {
    if (!Number.isFinite(submissionId)) {
      return this.answer(query.id, { text: this.texts('submissionNotFound'), showAlert: true });
    }
    const submission = await this.store.getSubmission(submissionId);
    if (!submission) return this.answer(query.id, { text: this.texts('submissionNotFound'), showAlert: true });
    await this.answer(query.id);

    const template = this.config.templates[submission.templateId];
    const body = composeSubmission(this.config, {
      data: submission.data,
      template,
      submissionId: submission.id,
      user: { fullName: submission.fullName, username: submission.username },
      attachments: attachmentsOf(submission.data, template),
      overrideText: submission.overrideText,
    });
    const keyboard = adminKeyboard(this.texts, submission.id, { review: submission.status !== 'published' });
    keyboard.inline_keyboard.push([{ text: this.texts('btnPanelBack'), callback_data: 'a:p:pending' }]);
    const header = this.texts('pendingTitle');
    return this.tryEditMarkup(
      query.message?.chat?.id ?? query.from.id,
      query.message?.message_id,
      `${header}\n\n${body}`,
      { keyboard },
    );
  }

  /** 「评论」面板：最近有评论的投稿 + 数量。 */
  async showCommentsPanel(chatId, messageId) {
    const items = await this.store.recentCommentedSubmissions(8);
    const back = singleButtonKeyboard(this.texts, 'btnPanelHome', 'a:p:home');
    if (items.length === 0) {
      return this.tryEditMarkup(chatId, messageId, this.texts('panelCommentsEmpty'), { keyboard: back });
    }
    return this.tryEditMarkup(
      chatId,
      messageId,
      `${this.texts('panelCommentsTitle')}\n\n${this.texts('panelCommentsHint')}`,
      { keyboard: commentsPanelKeyboard(this.texts, items) },
    );
  }

  async handleAdminCallback(query, data) {
    const from = query.from;
    if (!(await this.canModerate(from.id))) {
      return this.answer(query.id, { text: this.texts('adminOnlyHint'), showAlert: true });
    }
    const parts = data.split(':');
    const action = parts[1];
    const rawId = parts[2];
    const rest = parts.slice(3);
    const extra = rest[0];

    // 面板类回调没有"投稿 id"，必须先分流出去
    if (action === 'p') return this.handleAdminPanel(query, rawId);
    if (action === 'pv') return this.showPendingCard(query, Number.parseInt(rawId ?? '', 10));
    if (action === 'dw') {
      const watchChat = Number.parseInt(rawId ?? '', 10);
      if (!Number.isFinite(watchChat)) {
        return this.answer(query.id, { text: this.texts('diagNoTarget'), showAlert: true });
      }
      await this.answer(query.id, { text: '✅ 已就绪' });
      return this.armDiagWatch(watchChat, from.id);
    }

    const submissionId = Number.parseInt(rawId ?? '', 10);
    const submission = Number.isFinite(submissionId) ? await this.store.getSubmission(submissionId) : null;
    if (!submission) {
      return this.answer(query.id, { text: this.texts('submissionNotFound'), showAlert: true });
    }
    const message = query.message;

    switch (action) {
      case 'ok':
        return this.onApprove(query, submission, message);
      case 'no':
        return this.onRejectPrompt(query, submission, message);
      case 'nr':
        return this.onReject(query, submission, message, {
          reason: this.config.options.rejectReasons[Number.parseInt(extra ?? '', 10)] ?? '',
        });
      case 'nc':
        return this.onRejectCustom(query, submission);
      case 'nn':
        return this.onReject(query, submission, message, { reason: '' });
      case 'reply':
        return this.onReplyRequest(query, submission);
      case 'edit':
        return this.onEditRequest(query, submission);
      case 'edittext':
        return this.onEditTextRequest(query, submission);
      case 'editmedia':
        return this.onEditMediaRequest(query, submission);
      case 'emdone':
        return this.onEditMediaDone(query, submission, { clear: false });
      case 'emclear':
        return this.onEditMediaDone(query, submission, { clear: true });
      case 'cmt': {
        const offset = Number.parseInt(rest[0] ?? '0', 10);
        await this.answer(query.id);
        return this.adminComments(
          query.message?.chat?.id ?? query.from.id,
          submission.id,
          Number.isFinite(offset) ? offset : 0,
        );
      }
      case 'crc': {
        // a:crc:<投稿id>:<评论所在chat>:<评论message>
        const targetChat = Number.parseInt(rest[0] ?? '', 10);
        const targetMessage = Number.parseInt(rest[1] ?? '', 10);
        if (!Number.isFinite(targetChat) || !Number.isFinite(targetMessage)) {
          return this.answer(query.id, { text: this.texts('commentReplyNone'), showAlert: true });
        }
        await this.answer(query.id);
        await this.store.setAdminAction(from.id, `admin_comment_reply:${targetChat}:${targetMessage}`, submission.id);
        return this.reply(from.id, this.texts('adminCommentReplyPrompt', { submission_id: submission.id }));
      }
      case 'emcancel':
        await this.store.clearSessionMedia(query.from.id, editMediaKey(submission.id));
        await this.store.clearAdminAction(query.from.id);
        return this.answer(query.id, { text: this.texts('adminMediaKeepOld') });
      case 'pin':
        return this.onPin(query, submission);
      case 'recall':
        return this.onRecall(query, submission);
      case 'repub':
        return this.onRepublish(query, submission);
      case 'ban':
        await this.store.ban(submission.userId, '管理员在群内拉黑');
        await this.store.audit(from.id, 'user.ban', 'user', submission.userId, '管理员在投稿消息上拉黑');
        return this.answer(query.id, { text: this.texts('adminBanned', { user_id: submission.userId }) });
      default:
        return this.answer(query.id);
    }
  }

  /**
   * 审核通过的唯一实现。
   *
   * Telegram 群里的「通过」按钮和后台管理端都走这里 —— 两边各写一遍的话，
   * 投稿级租约只会挡住同一侧的双击，跨端的并发（群里点了通过、后台同时点
   * 通过）照样会把同一条投稿发两遍。
   *
   * 返回 { ok, reason?, published?, submission?, link? }；怎么回应用户由调用方
   * 决定（Telegram 应答 callbackQuery / 后台回 JSON）。
   */
  async approveSubmission(submissionId, { actorId = 0, actorLabel = 'web-admin' } = {}) {
    const submission = await this.store.getSubmission(submissionId);
    if (!submission) return { ok: false, reason: 'not_found' };
    if (submission.status === 'published') return { ok: false, reason: 'already_published', submission };
    // 投稿级租约：连点两次「通过」、或用户同时在自己发布，都只有一方能进来
    if (!(await this.acquireSubmissionLease(submission.id))) {
      const fresh = await this.store.getSubmission(submission.id);
      return {
        ok: false,
        reason: fresh?.status === 'published' ? 'already_published' : 'in_flight',
        submission: fresh ?? submission,
      };
    }
    const template = this.config.templates[submission.templateId];
    let published;
    try {
      published = await this.publish(submission, template, { review: false });
      await this.releaseSubmissionLease(submission.id, { published: true });
    } catch (error) {
      await this.releaseSubmissionLease(submission.id);
      // 全部失败就退回待审（还能再点一次通过）；部分失败标成 failed（重试会补发剩余目标）
      await this.store.updateSubmission(submission.id, { status: error?.partial ? 'failed' : 'pending' });
      const detail = String(error?.message ?? error);
      await this.store.audit(actorId, 'submission.approve_failed', 'submission', submission.id, detail);
      await this.notifyAdmins(
        this.texts('adminPublishFailed', { submission_id: submission.id, error: escapeHtml(detail) }),
      );
      return { ok: false, reason: 'publish_failed', error: detail, submission };
    }
    await this.store.audit(actorId, 'submission.approve', 'submission', submission.id, actorLabel);
    const link = linkForMessage(published.chatId, published.messageId, await this.ensureTargetChat());
    const notify = link ? this.texts('approved', { link }) : this.texts('approved', { link: '' }).trim();
    if (this.canNotifyAuthor(submission)) await this.tryReply(submission.userId, notify, { raw: true });
    else await this.deliverToWebAuthor(submission, notify);
    return { ok: true, published, submission, link };
  }

  async onApprove(query, submission, message) {
    const result = await this.approveSubmission(submission.id, {
      actorId: query.from.id,
      actorLabel: 'telegram',
    });
    if (!result.ok) {
      const text =
        result.reason === 'publish_failed'
          ? this.texts('republishFailed', { error: result.error })
          : result.reason === 'already_published'
            ? this.texts('adminAlreadyPublished')
            : this.texts('adminBeingPublished');
      return this.answer(query.id, { text, showAlert: true });
    }
    await this.answer(query.id, { text: this.texts('adminApprovedMsg', { submission_id: submission.id }) });

    if (message) {
      const note = `\n\n✅ 已通过（#${submission.id}）`;
      await this.tryEditMarkup(message.chat.id, message.message_id, message.text ? `${message.text}${note}` : null, {
        keyboard: adminKeyboard(this.texts, submission.id, {
          review: false,
          web: !this.canNotifyAuthor(submission),
        }),
      });
    }
    return undefined;
  }

  /** 点「拒绝」先把预设理由摆出来，管理员选一个或自己写。 */
  async onRejectPrompt(query, submission, message) {
    const keyboard = rejectReasonsKeyboard(this.texts, submission.id, this.config.options.rejectReasons);
    if (message) {
      await this.tryEditMarkup(
        message.chat.id,
        message.message_id,
        message.text
          ? `${message.text}\n\n${this.texts('rejectReasonPrompt', { submission_id: submission.id })}`
          : null,
        { keyboard },
      );
      return this.answer(query.id, { text: '选一个理由' });
    }
    return this.answer(query.id, { text: '选一个理由' });
  }

  /** 完成驳回：通知投稿者（可带理由），并把审核消息标记掉。 */
  /**
   * 审核驳回的唯一实现，和 approveSubmission 对称：Telegram 按钮和后台管理端
   * 共用，避免两侧各自改状态（比如后台刚驳回、群里同时点了通过）。
   */
  async rejectSubmission(submissionId, { actorId = 0, actorLabel = 'web-admin', reason = '' } = {}) {
    const submission = await this.store.getSubmission(submissionId);
    if (!submission) return { ok: false, reason: 'not_found' };
    if (submission.status === 'rejected') return { ok: false, reason: 'already_rejected', submission };
    // 已发布的投稿不能驳回：频道里那条消息已经存在，把状态改成 rejected 会留下
    // 「库里说已驳回、群里却还挂着」的不一致，且会误发一条"已驳回"给作者。
    // 要下架请先 removePublished 撤回消息，再走驳回。
    if (submission.status === 'published') return { ok: false, reason: 'already_published', submission };
    // 正在发布时不能改状态，否则群里已经发出去、记录却写成"已拒绝"
    if (await this.isPublishInFlight(submission.id)) return { ok: false, reason: 'in_flight', submission };
    await this.store.updateSubmission(submission.id, { status: 'rejected' });
    await this.store.audit(actorId, 'submission.reject', 'submission', submission.id, reason || actorLabel);
    const notice = this.texts('rejected', { reason: reason ? `\n\n理由：${escapeHtml(reason)}` : '' });
    if (this.canNotifyAuthor(submission)) await this.tryReply(submission.userId, notice, { raw: true });
    else await this.deliverToWebAuthor(submission, notice);
    return { ok: true, submission };
  }

  async onReject(query, submission, message, { reason = '' } = {}) {
    const result = await this.rejectSubmission(submission.id, {
      actorId: query.from.id,
      actorLabel: 'telegram',
      reason,
    });
    if (!result.ok) {
      const text =
        result.reason === 'already_rejected'
          ? this.texts('adminRejectedMsg', { submission_id: submission.id })
          : this.texts('adminBeingPublished');
      return this.answer(query.id, { text, showAlert: true });
    }
    await this.answer(query.id, { text: this.texts('adminRejectedMsg', { submission_id: submission.id }) });
    if (message) {
      const tail = reason ? `\n\n❌ 已拒绝：${reason}` : '\n\n❌ 已拒绝';
      await this.tryEditMarkup(message.chat.id, message.message_id, message.text ? `${message.text}${tail}` : null, {
        removeKeyboard: true,
      });
    }
    return undefined;
  }

  /** 「自己写一句」：等管理员私聊发理由。 */
  async onRejectCustom(query, submission) {
    const sent = await this.tryReply(query.from.id, this.texts('rejectCustomPrompt', { submission_id: submission.id }));
    if (!sent) {
      return this.answer(query.id, {
        text: '请先私聊机器人并发送 /start，我才能把输入框给你',
        showAlert: true,
      });
    }
    await this.store.setAdminAction(query.from.id, 'reject_custom', submission.id);
    return this.answer(query.id, { text: '已私聊你，请在那里输入理由' });
  }

  /** 撤回/删除群里的所有消息（含相册第 2..N 条与多目标）。 */
  async removePublished(submission) {
    let removed = false;
    for (const target of await this.store.listSubmissionTargetMessages(submission.id)) {
      for (const messageId of target.messageIds) {
        if (await this.tryDelete(target.chat_id, messageId)) removed = true;
      }
    }
    for (const row of await this.store.listPublishedMessageIds(submission.id)) {
      if (await this.tryDelete(row.chat_id, row.message_id)) removed = true;
    }
    if (removed) return true;
    // 兼容更早的历史数据（没有映射记录时退回旧字段）
    const ids =
      submission.messageIds?.length > 0
        ? submission.messageIds
        : [submission.mediaMessageId, submission.publishMessageId].filter(Boolean);
    let any = false;
    for (const messageId of ids) {
      if (await this.tryDelete(submission.publishChatId, messageId)) any = true;
    }
    return any;
  }

  /** 置顶已发布的投稿。 */
  async onPin(query, submission) {
    if (!submission.publishChatId || !submission.publishMessageId) {
      return this.answer(query.id, { text: this.texts('noPublishedMessage'), showAlert: true });
    }
    try {
      await this.tg.pinChatMessage(submission.publishChatId, submission.publishMessageId);
    } catch (error) {
      this.logger.warn?.(`置顶失败：${error?.message ?? error}`);
      return this.answer(query.id, { text: this.texts('pinFailed'), showAlert: true });
    }
    return this.answer(query.id, { text: this.texts('pinDone', { submission_id: submission.id }) });
  }

  /** 撤下：删掉群里的消息，但记录留着，可以一键重新发布。 */
  async onRecall(query, submission) {
    if (!submission.publishChatId || !submission.publishMessageId) {
      return this.answer(query.id, { text: this.texts('noPublishedMessage'), showAlert: true });
    }
    if (await this.isPublishInFlight(submission.id)) {
      return this.answer(query.id, { text: this.texts('adminBeingPublished'), showAlert: true });
    }
    await this.removePublished(submission);
    // 消息已经删了，映射和旧消息 id 一并清掉，避免下次"撤回"去删不存在的东西
    await this.store.clearPublishedMessages(submission.id);
    await this.store.clearSubmissionTargetMessages(submission.id);
    await this.store.updateSubmission(submission.id, {
      status: 'recalled',
      message_ids: JSON.stringify([]),
    });
    await this.tryReply(query.from.id, this.texts('recallDone', { submission_id: submission.id }), {
      raw: true,
      keyboard: republishKeyboard(this.texts, submission.id),
    });
    return this.answer(query.id, { text: this.texts('recallDone', { submission_id: submission.id }) });
  }

  async onRepublish(query, submission) {
    // 只有「已撤下 / 发布失败」的投稿能重新发布；而且不能趁别人正在发的时候插进来
    if (await this.isPublishInFlight(submission.id)) {
      return this.answer(query.id, { text: this.texts('adminBeingPublished'), showAlert: true });
    }
    if (!['recalled', 'failed'].includes(submission.status)) {
      return this.answer(query.id, { text: this.texts('republishNotAllowed'), showAlert: true });
    }
    if (!(await this.acquireSubmissionLease(submission.id, { reset: true }))) {
      return this.answer(query.id, { text: this.texts('republishNotAllowed'), showAlert: true });
    }
    const template = this.config.templates[submission.templateId];
    try {
      // 旧的群消息已经在撤下时删掉了，清掉映射后强制重发
      await this.store.clearPublishedMessages(submission.id);
      await this.store.clearSubmissionTargetMessages(submission.id);
      const published = await this.publish(submission, template, { review: false, force: true });
      await this.releaseSubmissionLease(submission.id, { published: true });
      const link = linkForMessage(published.chatId, published.messageId, await this.ensureTargetChat());
      await this.answer(query.id, { text: this.texts('republishedDone', { submission_id: submission.id }) });
      return this.tryEditMarkup(
        query.message?.chat?.id,
        query.message?.message_id,
        `${this.texts('republishedDone', { submission_id: submission.id })}${link ? `\n${link}` : ''}`,
        { removeKeyboard: true },
      );
    } catch (error) {
      this.logger.error?.('重新发布失败', error);
      await this.releaseSubmissionLease(submission.id);
      await this.store.updateSubmission(submission.id, { status: error?.partial ? 'failed' : 'recalled' });
      return this.answer(query.id, {
        text: this.texts('republishFailed', { error: error?.message ?? error }),
        showAlert: true,
      });
    }
  }

  /** 「编辑」：先问管理员要改文案还是改媒体。 */
  async onEditRequest(query, submission) {
    const sent = await this.tryReply(
      query.from.id,
      `${this.texts('adminEditMenuTitle', { submission_id: submission.id })}\n\n${this.texts('adminEditMenuHint')}`,
      { raw: true, keyboard: editActionKeyboard(this.texts, submission.id) },
    );
    if (!sent) {
      return this.answer(query.id, {
        text: '请先私聊机器人并发送 /start，我才能私聊你',
        showAlert: true,
      });
    }
    return this.answer(query.id, { text: '已私聊你，请选择改文案还是改媒体' });
  }

  /** 「改文案」：把当前文案私聊给管理员，改完发回来。 */
  async onEditTextRequest(query, submission) {
    const template = this.config.templates[submission.templateId];
    const draft =
      submission.overrideText ??
      composeSubmission(this.config, {
        data: submission.data,
        template,
        submissionId: submission.id,
        user: { fullName: submission.fullName, username: submission.username },
        attachments: attachmentsOf(submission.data, template),
      });
    const sent = await this.tryReply(query.from.id, this.texts('editDraftPrompt', { draft: escapeHtml(draft) }), {
      raw: true,
    });
    if (!sent) {
      return this.answer(query.id, {
        text: '请先私聊机器人并发送 /start，我才能把草稿发给你',
        showAlert: true,
      });
    }
    await this.store.setAdminAction(query.from.id, 'edit', submission.id);
    return this.answer(query.id, { text: '已私聊你草稿，改完发回来即可' });
  }

  /** 「改媒体」：在私聊里收集新的媒体，收集完整体替换（删旧消息 + 重发）。 */
  async onEditMediaRequest(query, submission) {
    const template = this.config.templates[submission.templateId];
    if (!this.defaultMediaStep(template)) {
      return this.answer(query.id, { text: this.texts('adminMediaNoStep'), showAlert: true });
    }
    if (await this.isPublishInFlight(submission.id)) {
      return this.answer(query.id, { text: this.texts('adminMediaNotAllowed'), showAlert: true });
    }
    // 清掉上一次没发完的暂存
    await this.store.clearSessionMedia(query.from.id, editMediaKey(submission.id));
    const sent = await this.tryReply(query.from.id, this.texts('adminMediaPrompt', { submission_id: submission.id }), {
      raw: true,
      keyboard: adminMediaKeyboard(this.texts, submission.id),
    });
    if (!sent) {
      return this.answer(query.id, {
        text: '请先私聊机器人并发送 /start，我才能私聊你',
        showAlert: true,
      });
    }
    await this.store.setAdminAction(query.from.id, 'edit_media', submission.id);
    return this.answer(query.id, { text: '已私聊你，请把新的媒体发过去' });
  }

  /** 「改媒体」收集阶段：管理员发来的附件进暂存区。 */
  async handleAdminPendingMedia(message, from, chatId) {
    const pending = await this.store.getAdminAction(from.id);
    if (pending?.action !== 'edit_media') return false;
    const attachment = extractAttachment(message);
    if (!attachment) return false;

    const key = editMediaKey(pending.submissionId);
    const limit = this.config.options.maxAttachments;
    const count = await this.store.countSessionMedia(from.id, key);
    const keyboard = adminMediaKeyboard(this.texts, pending.submissionId);
    if (count >= limit) {
      await this.tryReact(message.chat.id, message.message_id, '🤯');
      await this.tryReply(chatId, this.texts('stepMediaLimit', { max_attachments: limit }), {
        raw: true,
        keyboard,
      });
      return true;
    }
    let result;
    try {
      result = await this.store.appendSessionMedia(from.id, key, attachment);
    } catch (error) {
      this.logger.error?.('暂存新媒体失败', error);
      await this.tryReply(chatId, this.texts('mediaSaveFailed'));
      return true;
    }
    await this.tryReact(message.chat.id, message.message_id, result.inserted ? '✅' : '👍');
    // 这里故意不删管理员的消息：他要能看到自己发了什么。
    // 计数提示也带上按钮，保证"就这些了"始终在最新那条消息上。
    if (result.inserted) {
      await this.tryReply(chatId, this.texts('adminMediaCountHint', { count: count + 1 }), {
        raw: true,
        keyboard,
      });
    }
    return true;
  }

  /** 「就这些了 / 清空去掉媒体」：套用新媒体并重新发布。 */
  async onEditMediaDone(query, submission, { clear = false } = {}) {
    const pending = await this.store.getAdminAction(query.from.id);
    if (pending?.action !== 'edit_media' || Number(pending.submissionId) !== Number(submission.id)) {
      return this.answer(query.id, { text: this.texts('adminMediaStale'), showAlert: true });
    }
    const template = this.config.templates[submission.templateId];
    const mediaStepId = this.defaultMediaStep(template);
    if (!mediaStepId) {
      return this.answer(query.id, { text: this.texts('adminMediaNoStep'), showAlert: true });
    }
    const key = editMediaKey(submission.id);
    const rows = await this.store.listSessionMedia(query.from.id, key);
    if (!clear && rows.length === 0) {
      return this.answer(query.id, { text: this.texts('adminMediaEmpty'), showAlert: true });
    }
    // 只保留附件本身，别把暂存用的 mediaId/stepId 写进投稿数据
    const attachments = rows.map(({ mediaId, stepId, ...rest }) => rest);

    await this.store.clearAdminAction(query.from.id);
    await this.answer(query.id, { text: '正在替换媒体…' });
    const result = await this.applyMediaEdit(submission.id, { mediaStepId, attachments });
    await this.store.clearSessionMedia(query.from.id, key);

    const text = result.ok
      ? this.texts('adminMediaApplied', { submission_id: submission.id })
      : this.texts('republishFailed', { error: escapeHtml(result.error) });
    return this.tryEditMarkup(query.message?.chat?.id, query.message?.message_id, text, { removeKeyboard: true });
  }

  /**
   * 用新的媒体整体替换并重新发布。
   * Telegram 不允许改一条消息的媒体个数，所以统一走"删旧消息 + 重发"，
   * 代价是点赞/评论/置顶状态会丢（已与 Owner 确认接受）。
   */
  async applyMediaEdit(submissionId, { mediaStepId, attachments }) {
    const submission = await this.store.getSubmission(submissionId);
    if (!submission) return { ok: false, error: this.texts('submissionNotFound') };
    const template = this.config.templates[submission.templateId];
    if (!template) return { ok: false, error: this.texts('submissionNotFound') };
    // 先把别人正在发布的挡在外面，再复位租约（这次是合法的"再发一次"）
    if (await this.isPublishInFlight(submissionId)) {
      return { ok: false, error: this.texts('adminMediaNotAllowed') };
    }

    if (!(await this.acquireSubmissionLease(submissionId, { reset: true }))) {
      return { ok: false, error: this.texts('adminMediaNotAllowed') };
    }
    const wasPending = submission.status === 'pending';
    const reviewMode = wasPending && (await this.isReviewMode());
    const data = { ...submission.data, [mediaStepId]: attachments };
    const oldAttachments = attachmentsOf(submission.data, template);

    /**
     * 优先"就地换媒体"：媒体个数和类型都对得上时，用 editMessageMedia 逐条替换。
     * 这样点赞/评论/置顶都能保住，也不用删消息（消息链接不变）。
     * 个数变了就没法就地改（Telegram 的限制），回退到删旧消息 + 重发。
     */
    const editInPlace = await (async () => {
      if (wasPending || reviewMode) return false; // 审核卡片走重新送审更直观
      try {
        return await this.tryEditMediaInPlace(submission, template, oldAttachments, attachments, data);
      } catch (error) {
        this.logger.warn?.(`就地替换媒体失败，改走重发：${error?.message ?? error}`);
        return false;
      }
    })();

    try {
      if (editInPlace) {
        await this.store.updateSubmissionContent(submissionId, {
          data,
          contentHash: submission.contentHash,
          flags: submission.flags,
          username: submission.username,
          fullName: submission.fullName,
        });
        await this.store.updateSubmission(submissionId, { status: 'published' });
        await this.releaseSubmissionLease(submissionId, { published: true });
        return { ok: true, inPlace: true };
      }

      await this.store.updateSubmissionContent(submissionId, {
        data,
        contentHash: submission.contentHash,
        flags: submission.flags,
        username: submission.username,
        fullName: submission.fullName,
      });
      await this.removePublished(submission);
      await this.store.clearPublishedMessages(submissionId);
      await this.store.clearSubmissionTargetMessages(submissionId);

      const updated = { ...submission, data };
      const published = await this.publish(updated, template, { review: reviewMode, force: true });
      if (reviewMode) {
        await this.store.updateSubmission(submissionId, { status: 'pending' });
        await this.releaseSubmissionLease(submissionId);
      } else {
        await this.releaseSubmissionLease(submissionId, { published: true });
      }
      return { ok: true, published };
    } catch (error) {
      this.logger.error?.('替换媒体后重新发布失败', error);
      await this.releaseSubmissionLease(submissionId);
      await this.store.updateSubmission(submissionId, { status: wasPending ? 'pending' : 'failed' });
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 试探能否就地替换：要求每个目标都发全了、媒体条数一致、类型序列一致。
   * 任何一条不满足就返回 false，由调用方回退成"删旧消息 + 重发"。
   */
  async tryEditMediaInPlace(submission, template, oldAttachments, attachments, newData) {
    // Telegram 改不了"一条消息的媒体个数"，也没法把新消息塞进已有的媒体组，
    // 所以只有"变少或不变"能就地处理；变多必须回退成删旧+重发。
    if (attachments.length > oldAttachments.length) return false;
    if (oldAttachments.length === 0) return false;

    const state = await this.store.publishedState(submission.id);
    if (state.size === 0) return false;

    // 先整体规划，确认所有目标都能就地改，再动手（避免改了一半才发现不行）
    const plan = [];
    for (const [chatId, flags] of state) {
      if (!flags.text) return false; // 上次发布不完整，交给重发逻辑
      const ids = await this.store.listPublishedMessageIdsForChat(submission.id, chatId, 'published_media');
      if (ids.length !== oldAttachments.length) return false;
      plan.push({ chatId, ids });
    }

    const caption =
      attachments.length > 0
        ? fitHtml(mediaCaption(this.config, { data: newData, template, attachments }), MAX_CAPTION)
        : undefined;

    const patch = {};
    for (const { chatId, ids } of plan) {
      for (let index = 0; index < ids.length; index += 1) {
        if (index < attachments.length) {
          // 逐条就地换媒体：消息 id 不变，点赞/评论/置顶都保住
          await this.tg.editMessageMedia(
            chatId,
            ids[index],
            { type: attachments[index].kind, media: attachments[index].fileId },
            { caption: index === 0 ? caption : undefined },
          );
        } else {
          // 多出来的媒体消息删掉（只会丢这几条的互动），并把映射一起忘掉
          await this.tryDelete(chatId, ids[index]);
          await this.store.forgetPublishedMessage(chatId, ids[index]);
        }
      }
      const remaining = await this.store.listPublishedMessageIdsForChat(submission.id, chatId, 'published_media');
      const textId = await this.store.firstPublishedMessageId(submission.id, chatId, 'published_text');
      const target = await this.store.getPublishTargetByChat(chatId);
      if (target) {
        await this.store.saveSubmissionTargetMessages(submission.id, target.id, [...remaining, textId].filter(Boolean));
      }
      if (Number(chatId) === Number(submission.publishChatId)) {
        patch.media_message_id = remaining[0] ?? null;
        patch.media_chat_id = remaining.length > 0 ? chatId : null;
        patch.message_ids = JSON.stringify([...remaining, textId].filter(Boolean));
      }
    }

    await this.store.updateSubmission(submission.id, { ...patch, status: 'published' });
    return true;
  }

  async onReplyRequest(query, submission) {
    if (!this.canNotifyAuthor(submission)) {
      // 网页投稿者没有 Telegram：回复会落到他的网页收件箱（有邮箱还会发邮件）
      await this.store.setAdminAction(query.from.id, 'reply', submission.id);
      return this.answer(query.id, { text: this.texts('webReplyToInbox'), showAlert: true });
    }
    const sent = await this.tryReply(
      query.from.id,
      this.texts('adminReplyPrompt', { submission_id: submission.id, user_id: submission.userId }),
    );
    if (!sent) {
      return this.answer(query.id, {
        text: '请先私聊机器人并发送 /start，之后我才能把回复内容发给你',
        showAlert: true,
      });
    }
    await this.store.setAdminAction(query.from.id, 'reply', submission.id);
    return this.answer(query.id, { text: '已私聊你，请在那里输入内容' });
  }

  // ------------------------------------------------------------------
  // 管理员待输入
  // ------------------------------------------------------------------

  async handleAdminPendingText(message, from, chatId, text) {
    const pending = await this.store.getAdminAction(from.id);
    if (!pending) return false;

    if (text === '/cancel') {
      await this.store.clearAdminAction(from.id);
      await this.reply(chatId, this.texts('adminReplyCancel'));
      return true;
    }
    // 「接着说」交给下面的对话逻辑处理，别在这里被当成驳回
    if (pending.action === 'user_tell') return false;
    // 评论相关的动作是"用户态"的，交给 handleThreadReply 处理（管理员评论时也一样）
    if (pending.action.startsWith('public_comment:') || pending.action.startsWith('comment_reply')) return false;
    // 「改媒体」收集阶段只认附件：文字在这里给提示，且不能清掉这个动作
    if (pending.action === 'edit_media') {
      await this.reply(chatId, `${this.texts('adminMediaEmpty')}\n${this.texts('adminMediaRemovedHint')}`);
      return true;
    }
    if (text.startsWith('/') && text !== '/skip') return false;

    // 空内容不能当成有效输入（尤其别把 override_text 写成空）
    if (!text.trim() && text !== '/skip') {
      await this.reply(chatId, this.texts('adminReplyEmpty'));
      return true;
    }
    // /skip 对「回复」和「编辑」等于取消
    if (text === '/skip' && pending.action !== 'reject_custom') {
      await this.store.clearAdminAction(from.id);
      await this.reply(chatId, this.texts('adminReplyCancel'));
      return true;
    }

    const submission = await this.store.getSubmission(pending.submissionId);
    if (!submission) {
      await this.store.clearAdminAction(from.id);
      await this.reply(chatId, this.texts('submissionNotFound'));
      return true;
    }
    await this.store.clearAdminAction(from.id);

    if (pending.action.startsWith('admin_comment_reply')) {
      // 管理员从面板回复某条公开评论
      const [, rawChat, rawMessage] = String(pending.action).split(':');
      const targetChat = Number.parseInt(rawChat ?? '', 10);
      const targetMessage = Number.parseInt(rawMessage ?? '', 10);
      const comment =
        Number.isFinite(targetChat) && Number.isFinite(targetMessage)
          ? await this.store.getComment(targetChat, targetMessage)
          : null;
      let sent;
      try {
        sent = await this.tg.sendMessage(targetChat, this.texts('adminCommentReply', { text: escapeHtml(text) }), {
          replyTo: targetMessage,
          threadId: comment?.thread_id ?? undefined,
        });
      } catch (error) {
        this.logger.warn?.(`管理员回复评论失败：${error?.message ?? error}`);
        await this.reply(chatId, this.texts('republishFailed', { error: escapeHtml(String(error?.message ?? error)) }));
        return true;
      }
      // 同样记进评论表：别人回复这条"管理员回复"时也能接上同一条投稿
      if (sent?.message_id) {
        await this.store.rememberComment({
          chatId: targetChat,
          messageId: sent.message_id,
          submissionId: submission.id,
          threadId: comment?.thread_id ?? null,
          authorId: null,
          authorName: this.texts('commentAdminLabel'),
          text,
          parentMessageId: Number.isFinite(targetMessage) ? targetMessage : null,
          parentAuthorName: this.commentParentLabel(comment),
          kind: 'admin_reply',
        });
      }
      await this.reply(chatId, this.texts('adminCommentReplyDone'));
      return true;
    }

    if (pending.action === 'reply') {
      // 双向对话：转达给投稿者，并留一个"接着聊"的入口
      await this.deliverToUser(submission, this.texts('adminReply', { text: escapeHtml(text) }));
      await this.reply(chatId, this.texts('adminReplyDone'));
      return true;
    }

    if (pending.action === 'reject_custom') {
      if (await this.isPublishInFlight(submission.id)) {
        await this.reply(chatId, this.texts('adminBeingPublished'));
        return true;
      }
      const reason = text === '/skip' ? '' : escapeHtml(text);
      await this.store.updateSubmission(submission.id, { status: 'rejected' });
      if (this.canNotifyAuthor(submission)) {
        await this.tryReply(
          submission.userId,
          this.texts('rejected', { reason: reason ? `\n\n理由：${reason}` : '' }),
          {
            raw: true,
          },
        );
      }
      await this.reply(chatId, this.texts('adminRejectDone', { submission_id: submission.id }));
      return true;
    }

    if (pending.action === 'edit') {
      const draft = text.trim();
      if (submission.status === 'pending') {
        // 审核中的投稿：按管理员改过的版本直接发布。
        // 先拿租约再写 override_text，避免"草稿写进库了但根本没发出去"
        if (!(await this.acquireSubmissionLease(submission.id))) {
          await this.reply(chatId, this.texts('adminBeingPublished'));
          return true;
        }
        await this.store.updateSubmission(submission.id, { override_text: draft });
        const template = this.config.templates[submission.templateId];
        const updated = { ...submission, overrideText: draft };
        try {
          const published = await this.publish(updated, template, { review: false });
          await this.releaseSubmissionLease(submission.id, { published: true });
          const link = linkForMessage(published.chatId, published.messageId, await this.ensureTargetChat());
          await this.reply(chatId, this.texts('editDone', { submission_id: submission.id }));
          if (this.canNotifyAuthor(submission)) {
            await this.tryReply(
              submission.userId,
              link ? this.texts('approved', { link }) : this.texts('submittedNoLink'),
            );
          }
        } catch (error) {
          this.logger.error?.('按改后文案发布失败', error);
          await this.releaseSubmissionLease(submission.id);
          await this.store.updateSubmission(submission.id, {
            status: error?.partial ? 'failed' : 'pending',
          });
          await this.reply(chatId, this.texts('republishFailed', { error: error?.message ?? error }));
        }
        return true;
      }
      if (await this.isPublishInFlight(submission.id)) {
        await this.reply(chatId, this.texts('adminBeingPublished'));
        return true;
      }
      await this.store.updateSubmission(submission.id, { override_text: draft });
      if (submission.publishChatId && submission.publishMessageId) {
        try {
          await this.tg.editMessageText(submission.publishChatId, submission.publishMessageId, draft, {
            keyboard: adminKeyboard(this.texts, submission.id, {
              review: false,
              web: !this.canNotifyAuthor(submission),
            }),
          });
          await this.reply(chatId, this.texts('editDone', { submission_id: submission.id }));
        } catch (error) {
          this.logger.warn?.(`改写群消息失败：${error?.message ?? error}`);
          await this.reply(chatId, this.texts('republishFailed', { error: error?.message ?? error }));
        }
        return true;
      }
      await this.reply(chatId, this.texts('noPublishedMessage'));
      return true;
    }

    // 兜底：未知的管理员动作绝不能当成"驳回去发给投稿者"
    await this.reply(chatId, this.texts('adminReplyCancel'));
    return true;
  }

  // ------------------------------------------------------------------
  // 群消息
  // ------------------------------------------------------------------

  async handleChannelPost(message) {
    const chat = message.chat ?? {};
    const text = (message.text ?? message.caption ?? '').trim();
    if (!text.startsWith('/bind')) return undefined;
    // channel_post 没有可靠的 from；只能验证 Bot 已在频道中且当前 Owner 本人也是频道管理员。
    const owners = this.config.admins.filter(Boolean);
    if (owners.length === 0) return undefined;
    let admins;
    try {
      admins = await this.tg.getChatAdministrators(chat.id);
    } catch (error) {
      this.logger.warn?.(`读取频道管理员失败：${error?.message ?? error}`);
      return this.tryReply(chat.id, '⚠️ 无法验证频道管理员，请确认我已被设为频道管理员。');
    }
    const ownerIsAdmin = admins.some((member) => owners.includes(member.user?.id));
    if (!ownerIsAdmin) return this.tryReply(chat.id, '⛔ 只有机器人 Owner 本人作为频道管理员时，才能绑定这个频道。');
    let info = chat;
    try {
      info = await this.tg.getChat(chat.id);
    } catch {}
    const target = await this.store.upsertPublishTarget({
      chatId: chat.id,
      chatType: chat.type || 'channel',
      title: info?.title ?? chat.title ?? null,
      username: info?.username ?? chat.username ?? null,
      threadId: null,
      addedBy: owners[0],
    });
    await this.store.audit(owners[0], 'publish_target.bind', 'chat', chat.id, 'channel');
    if (target)
      return this.tryReply(
        chat.id,
        `✅ 已授权「${escapeHtml(info?.title ?? chat.title ?? '频道')}」作为投稿发布目标。\n发布位置：频道主消息区。`,
      );
    return undefined;
  }

  async handleGroupMessage(message) {
    // 0) 布置过"收不收得到群消息"的测试 → 私聊回报结果
    await this.checkDiagWatch(message);
    // 1) 回复已发布的投稿 = 公开评论（管理员也一样，不再偷偷转成私聊）
    if (message.reply_to_message && (await this.handleDiscussionComment(message))) return undefined;
    const text = (message.text ?? '').trim();
    if (!text.startsWith('/')) return undefined;
    return this.handleCommand(message, {
      chatId: message.chat.id,
      from: message.from,
      isPrivate: false,
    });
  }

  // ------------------------------------------------------------------
  // Telegram 官方评论区
  // ------------------------------------------------------------------

  /**
   * 有人在讨论组/群里回复了已发布的投稿，或者回复了别人的评论（评论的评论）。
   * 三种形态都支持：直接回复群里那条投稿；回复某条评论；回复频道帖在讨论组的转发副本。
   */
  async handleDiscussionComment(message) {
    if (!this.config.options.discussionComments) return false;
    const from = message.from;
    if (!from || from.is_bot) return false;
    const replyTo = message.reply_to_message;

    let submissionId = await this.store.findSubmissionByMessage(message.chat.id, replyTo.message_id);
    let parent = null;
    if (!submissionId) {
      // 回复的是"一条评论"（包括作者/管理员的回复，它们也记在评论表里）→ 顺着它找到投稿
      parent = await this.store.getComment(message.chat.id, replyTo.message_id);
      if (parent) submissionId = parent.submission_id;
    }
    if (!submissionId) submissionId = await this.resolveForwardedSubmission(replyTo);
    if (!submissionId) return false;

    const submission = await this.store.getSubmission(submissionId);
    if (!submission) return false;

    const text = (message.text ?? message.caption ?? '').trim();
    if (text) {
      await this.store.rememberComment({
        chatId: message.chat.id,
        messageId: message.message_id,
        submissionId,
        threadId: message.message_thread_id ?? null,
        authorId: from.id,
        authorName: fullName(from),
        text,
        parentMessageId: parent?.message_id ?? null,
        parentAuthorName: this.commentParentLabel(parent),
        kind: 'user',
      });
    }

    // 作者自己评论自己的投稿不用通知
    if (Number(from.id) === Number(submission.userId)) return true;

    await this.notifyAuthorAboutComment(submission, message, from);
    return true;
  }

  /** 评论要回复的那条评论是谁说的（作者/管理员/某位群友）。 */
  commentParentLabel(parent) {
    if (!parent) return null;
    if (parent.kind === 'author_reply') return this.texts('commentAuthorLabel');
    if (parent.kind === 'admin_reply') return this.texts('commentAdminLabel');
    return parent.author_name || null;
  }

  /** 评论通知正文：把窗口内最新的一批评论拼成一条消息。 */
  commentNotifyText(submissionId, comments, windowCount) {
    const lines = comments.map((row) =>
      row.parent_author_name
        ? this.texts('commentNotifyReplyItem', {
            name: escapeHtml(row.author_name || String(row.author_id ?? '有人')),
            target: escapeHtml(row.parent_author_name),
            text: escapeHtml(truncate(row.text || '（附件）', 200)),
          })
        : this.texts('commentNotifyItem', {
            name: escapeHtml(row.author_name || String(row.author_id ?? '有人')),
            text: escapeHtml(truncate(row.text || '（附件）', 200)),
          }),
    );
    const parts = [this.texts('commentNotify', { submission_id: submissionId, count: windowCount }), '', ...lines];
    if (windowCount > comments.length) {
      parts.push('', this.texts('commentNotifyMore', { count: windowCount, shown: comments.length }));
    }
    return parts.join('\n');
  }

  /**
   * 通知作者有人评论。
   * 同一投稿 + 同一作者只维护"当前这条通知消息"：冷却窗口内的新评论都编辑进这一条，
   * 所以爆款投稿也不会把作者的私聊刷屏；正文只列最新的 N 条，每条都有「回复 N」按钮。
   * 网页投稿（没有 Telegram 账号）直接跳过。
   */
  async notifyAuthorAboutComment(submission, message, from) {
    // 网页投稿没有 Telegram：发邮件 + 写进网页收件箱（未读计数由收件箱页面消费）
    if (!(Number(submission.userId) > 0)) {
      const email = submission.data?.__email;
      if (email) {
        const text =
          `你的投稿收到新评论\n\n` +
          `${from ? fullName(from) + '：' : ''}${(message.text ?? message.caption ?? '').trim()}\n\n` +
          `查看并回复：${this.config.options.webPublicUrl ? `${this.config.options.webPublicUrl}/inbox` : ''}`;
        await this.sendWebEmail(email, `投稿 #${submission.id} 收到新评论`, text);
      }
      return;
    }
    const { options } = this.config;
    const now = nowSeconds();
    const stored = await this.store.getComment(message.chat.id, message.message_id);
    const fallback = {
      chat_id: message.chat.id,
      message_id: message.message_id,
      author_name: fullName(from),
      text: (message.text ?? message.caption ?? '').trim(),
      created_at: stored?.created_at ?? now,
    };
    const existing = await this.store.getCommentNotification(submission.id, submission.userId);
    const batchable = Boolean(existing) && now - existing.window_start < options.commentNotifyCooldownSeconds;

    let comments;
    let windowStart;
    let windowCount;
    if (batchable) {
      windowStart = existing.window_start;
      windowCount = Number(existing.count ?? 0) + 1;
      comments = await this.store.listCommentsSince(submission.id, windowStart, options.commentNotifyMax);
      if (comments.length === 0) {
        comments = [fallback];
        windowStart = fallback.created_at;
        windowCount = 1;
      }
    } else {
      windowStart = fallback.created_at;
      windowCount = 1;
      comments = [fallback];
    }

    const text = this.commentNotifyText(submission.id, comments, windowCount);
    const keyboard = commentUserKeyboard(this.texts, submission.id, comments);

    if (batchable && existing) {
      const edited = await this.tryEditMarkup(existing.chat_id, existing.message_id, text, { keyboard });
      if (edited) {
        await this.store.upsertCommentNotification({
          submissionId: submission.id,
          userId: submission.userId,
          chatId: existing.chat_id,
          messageId: existing.message_id,
          windowStart,
          count: windowCount,
        });
        return;
      }
    }

    const sent = await this.tryReply(submission.userId, text, { raw: true, keyboard });
    if (!sent?.message_id) return;
    await this.store.upsertCommentNotification({
      submissionId: submission.id,
      userId: submission.userId,
      chatId: submission.userId,
      messageId: sent.message_id,
      windowStart,
      count: windowCount,
    });
    await this.store.rememberThreadMessage(submission.userId, sent.message_id, submission.id, 'to_user');
  }

  /** 回复的是频道帖在讨论组的转发副本时，从 forward_origin 反查原帖。 */
  async resolveForwardedSubmission(replyTo) {
    const origin = replyTo?.forward_origin;
    if (origin?.type === 'channel' && origin.chat?.id && origin.message_id) {
      return this.store.findSubmissionByMessage(origin.chat.id, origin.message_id);
    }
    if (replyTo?.forward_from_chat?.id && replyTo?.forward_from_message_id) {
      return this.store.findSubmissionByMessage(replyTo.forward_from_chat.id, replyTo.forward_from_message_id);
    }
    return null;
  }

  /** 作者对某条评论的匿名回复：以机器人身份发回评论区。 */
  async postCommentReply(submissionId, message, from, chatId, target = null) {
    const text = (message.text ?? message.caption ?? '').trim();
    if (!text) {
      await this.tryReply(chatId, this.texts('stepTextExpected'));
      return true;
    }
    const submission = await this.store.getSubmission(submissionId);
    if (!submission) {
      await this.tryReply(chatId, this.texts('threadClosed'));
      return true;
    }
    // 优先回复用户点的那一条；没有指定就回最新一条
    let comment = null;
    if (target && Number.isFinite(target.chatId) && Number.isFinite(target.messageId)) {
      comment = await this.store.getComment(target.chatId, target.messageId);
    }
    if (!comment) comment = await this.store.latestComment(submissionId);
    if (!comment) {
      await this.store.clearAdminAction(from.id);
      await this.tryReply(chatId, this.texts('commentReplyNone'));
      return true;
    }
    // 投稿当初选了"显示昵称/自定义署名"，回复评论时也照这个显示；匿名就保持匿名
    const signature = authorDisplayName(this.config, submission.data, {
      fullName: submission.fullName,
      username: submission.username,
    });
    const body = signature
      ? this.texts('authorCommentReplyNamed', { name: escapeHtml(signature), text: escapeHtml(text) })
      : this.texts('authorCommentReply', { text: escapeHtml(text) });
    let sent;
    try {
      sent = await this.tg.sendMessage(comment.chat_id, body, {
        replyTo: comment.message_id,
        threadId: comment.thread_id ?? undefined,
      });
    } catch (error) {
      this.logger.warn?.(`回复评论失败：${error?.message ?? error}`);
      await this.tryReply(
        chatId,
        this.texts('republishFailed', { error: escapeHtml(String(error?.message ?? error)) }),
      );
      return true;
    }
    // 记进评论表：别人再回复这条"作者回复"时才能找到它属于哪条投稿，继续往下接
    await this.store.rememberComment({
      chatId: comment.chat_id,
      messageId: sent.message_id,
      submissionId: submission.id,
      threadId: comment.thread_id ?? null,
      authorId: null,
      authorName: signature || this.texts('commentAuthorLabel'),
      text,
      parentMessageId: comment.message_id,
      parentAuthorName: this.commentParentLabel(comment),
      kind: 'author_reply',
    });
    await this.store.clearAdminAction(from.id);
    if (this.config.options.deleteUserMessages) await this.tryDelete(chatId, message.message_id);
    await this.tryReply(chatId, this.texts('commentReplySent'));
    return true;
  }

  /** 作者查看自己某条投稿的全部评论（分页 + 每条一个匿名回复按钮）。 */
  async showAuthorComments(chatId, userId, submissionId, offset = 0) {
    const submission = Number.isFinite(submissionId) ? await this.store.getSubmission(submissionId) : null;
    if (!submission || Number(submission.userId) !== Number(userId)) {
      return this.reply(chatId, this.texts('commentInboxDenied'));
    }
    const total = await this.store.countComments(submission.id);
    if (total === 0) return this.reply(chatId, this.texts('commentInboxEmpty'));
    const limit = 5;
    const safe = Math.max(0, Math.min(offset, Math.max(0, total - 1)));
    const comments = await this.store.listComments(submission.id, limit, safe);
    if (comments.length === 0) return this.reply(chatId, this.texts('adminCommentsEnd'));
    const lines = comments.map((row) =>
      this.texts('commentNotifyItem', {
        name: escapeHtml(commentDisplayName(row)),
        text: escapeHtml(truncate(row.text || '（附件）', 200)),
      }),
    );
    const range = this.texts('adminCommentsRange', { from: safe + 1, to: safe + comments.length, total });
    return this.reply(
      chatId,
      `${this.texts('commentInboxTitle', { submission_id: submission.id })}\n${range}\n\n${lines.join('\n')}\n\n${this.texts('commentInboxHint')}`,
      {
        raw: true,
        keyboard: commentInboxKeyboard(this.texts, submission.id, comments, { offset: safe, limit, total }),
      },
    );
  }

  /** 管理员查某条投稿收到的评论（支持分页）。 */
  async adminComments(chatId, submissionId, offset = 0) {
    if (!Number.isFinite(submissionId)) return this.reply(chatId, this.texts('adminCommentsUsage'));
    const total = await this.store.countComments(submissionId);
    if (total === 0) return this.reply(chatId, this.texts('adminCommentsEmpty'));
    const limit = 10;
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, total - 1)));
    const comments = await this.store.listComments(submissionId, limit, safeOffset);
    if (comments.length === 0) return this.reply(chatId, this.texts('adminCommentsEnd'));
    const items = comments
      .map((row) =>
        this.texts('adminCommentsItem', {
          name: escapeHtml(commentDisplayName(row)),
          text: escapeHtml(truncate(row.text || '', 120)),
        }),
      )
      .join('\n');
    const range = this.texts('adminCommentsRange', {
      from: safeOffset + 1,
      to: safeOffset + comments.length,
      total,
    });
    return this.reply(
      chatId,
      `${this.texts('adminCommentsTitle', { submission_id: submissionId, count: total })}\n${range}\n\n${items}`,
      {
        raw: true,
        keyboard: commentAdminKeyboard(this.texts, submissionId, comments, { offset: safeOffset, limit, total }),
      },
    );
  }

  // ------------------------------------------------------------------
  // 网页投稿（/submit）
  // ------------------------------------------------------------------

  /** 网页投稿要不要审核：全局审核模式开着，或者 WEB_REQUIRE_REVIEW 没关。 */
  async webNeedsReview() {
    return (await this.isReviewMode()) || this.config.options.webRequireReview;
  }

  /** 投稿者能不能用 Telegram 私聊联系（网页投稿没有 Telegram 账号，userId 记 0）。 */
  canNotifyAuthor(submission) {
    return Number(submission?.userId) > 0;
  }

  /**
   * 把网页上传的文件交给 Telegram 换成 file_id。
   * 平台不落地任何文件：发布时直接用 file_id，和 Telegram 投稿走同一条路。
   */
  async uploadWebMedia(files, { chatId } = {}) {
    const attachments = [];
    const uploaded = [];
    for (const item of files ?? []) {
      const method = item.kind === 'photo' ? 'sendPhoto' : item.kind === 'video' ? 'sendVideo' : 'sendDocument';
      const field = item.kind === 'photo' ? 'photo' : item.kind === 'video' ? 'video' : 'document';
      const message = await this.tg.uploadFile(method, field, chatId, item.file, { filename: item.name });
      const attachment = extractAttachment(message);
      if (!attachment) throw new Error('上传后的附件信息不完整');
      attachments.push(attachment);
      uploaded.push(message.message_id);
    }
    return { attachments, uploaded };
  }

  /** 网页投稿的审核卡片正文：和 Telegram 审核流同一套渲染 + 来源标记。 */
  webReviewText(submission, template) {
    const attachments = attachmentsOf(submission.data, template);
    let text = composeSubmission(this.config, {
      data: submission.data,
      template,
      submissionId: submission.id,
      user: { fullName: submission.fullName, username: null },
      attachments,
    });
    const lines = [this.texts('webReviewSource')];
    if (submission.data?.__ip) lines.push(`IP：${escapeHtml(String(submission.data.__ip))}`);
    const notes = reviewNotes(this.texts, { flags: submission.flags ?? [], stats: null });
    const extra = [...lines, ...notes].join('\n');
    if (text.length + extra.length + 2 <= MAX_PUBLISH_TEXT) text = `${text}\n\n${extra}`;
    return text;
  }

  /**
   * 后台审核详情：把一条网页投稿摊平成前端能直接渲染的结构。
   *
   * 不把模板结构透给前端 —— 模板是运营在改的（TEMPLATES_JSON），前端要是跟着
   * 解析一遍，模板一改后台就白屏。这里直接给出「管理员判断需要的东西」：谁投的、
   * 投了什么、有没有命中敏感词、以及一段拿去就能发布的正文。
   */
  webReviewDetail(submission) {
    const template = this.config.templates[submission.templateId];
    const data = submission.data ?? {};
    return {
      id: submission.id,
      status: submission.status,
      templateId: submission.templateId,
      nickname: typeof data.__nickname === 'string' ? data.__nickname : '',
      fullName: submission.fullName ?? '',
      // 邮箱是网页投稿者唯一的联系方式（没有 Telegram 身份），审核时要能看见。
      email: typeof data.__email === 'string' ? data.__email : '',
      ip: typeof data.__ip === 'string' ? data.__ip : '',
      flags: submission.flags ?? [],
      createdAt: submission.createdAt ?? null,
      publishedAt: submission.publishedAt ?? null,
      attachments: attachmentsOf(data, template).map((item) => ({
        kind: item.kind ?? 'document',
        name: item.name ?? null,
      })),
      text: template ? this.webReviewText(submission, template) : '',
    };
  }

  /**
   * 取一条网页投稿的第 index 个附件，返回可以原样转发给浏览器的字节流。
   *
   * 返回值约定：
   *   null                → 没有这个附件 / 附件没有 file_id / Telegram 取不到
   *   { tooLarge, size }  → 超过 MAX_WEB_MEDIA_BYTES，调用方应回 413 而不是硬传
   *   其余                → { stream, contentType, length, filename, inline }
   *
   * `inline` 只对 photo / video 为 true。document 一律让浏览器下载而不是内联：
   * 上传的是运营没审过的文件，PDF 之外的东西（尤其 svg / html）一旦内联渲染就是
   * 同源 stored XSS，而这条接口挂的正是后台域名。
   */
  async openWebSubmissionMedia(submission, index) {
    const template = this.config.templates[submission?.templateId];
    const attachments = attachmentsOf(submission?.data ?? {}, template);
    if (!Number.isInteger(index) || index < 0 || index >= attachments.length) return null;

    const attachment = attachments[index];
    const fileId = typeof attachment?.fileId === 'string' ? attachment.fileId : '';
    if (!fileId) return null;

    const info = await this.tg.call('getFile', { file_id: fileId });
    const filePath = typeof info?.file_path === 'string' ? info.file_path : '';
    if (!filePath) return null;

    const size = Number(info.file_size ?? 0);
    if (Number.isFinite(size) && size > MAX_WEB_MEDIA_BYTES) return { tooLarge: true, size };

    /* 下载走裸 fetch 而不是 this.tg.call()：call() 会 json() 一次响应体，那是给
     * Bot API 的。文件下载返回的是字节流，解析成 JSON 必然失败。 */
    const response = await this.tg.fetch(`${this.tg.apiBase}/file/bot${this.tg.token}/${filePath}`);
    if (!response.ok || !response.body) return null;

    const kind = typeof attachment.kind === 'string' ? attachment.kind : 'document';
    const extension = extensionOf(filePath);
    return {
      stream: response.body,
      contentType: mediaContentType(filePath),
      length: Number(response.headers.get('content-length') ?? 0) || (size > 0 ? size : null),
      filename: attachment.name ?? `attachment-${index + 1}${extension}`,
      inline: kind === 'photo' || kind === 'video',
    };
  }

  /**
   * 创建一条网页投稿：上传媒体 → 建记录 → 送审（默认）或直接发布。
   * 返回 { id, status, link }。
   */
  async createWebSubmission({
    templateId,
    data,
    files = [],
    mediaStepId = null,
    nickname = '',
    ip = null,
    viewer = null,
    email = null,
  }) {
    const template = this.config.templates[templateId];
    if (!template) throw new Error(`模板不存在：${templateId}`);

    // 媒体得先落进某个会话才能换到 file_id：优先审核群，没有就借第一个管理员的私聊
    const reviewChatId = await this.effectiveReviewChatId();
    const uploadChatId = reviewChatId ?? this.config.admins[0] ?? null;
    if (uploadChatId === null) throw new Error('没有可用的上传会话：请配置 ADMIN_CHAT_ID 或 ADMIN_IDS');

    const { attachments, uploaded } = await this.uploadWebMedia(files, { chatId: uploadChatId });

    const payload = { ...data };
    if (mediaStepId) payload[mediaStepId] = attachments;
    payload.__source = 'web';
    if (ip) payload.__ip = ip;
    // 网页投稿没有 Telegram 身份：用浏览器令牌当"我是谁"，收件箱/评论通知/回复都靠它
    if (viewer) payload.__viewer = viewer;
    if (email) payload.__email = email;

    const review = await this.webNeedsReview();
    const screening = await this.screenSubmission({ userId: 0, data: payload });
    // 敏感词/链接：审核模式交给管理员判断，自动发布模式直接拒
    if (screening.blocked && !review) throw new Error(screening.blocked);

    const fullName = nickname || '网页访客';
    const submissionId = await this.store.createSubmission({
      userId: 0,
      username: null,
      fullName,
      templateId,
      data: payload,
      contentHash: screening.hash,
      flags: screening.flags,
    });
    const submission = {
      id: submissionId,
      userId: 0,
      username: null,
      fullName,
      templateId,
      data: payload,
      status: 'pending',
      flags: screening.flags,
    };

    if (review) {
      await this.deliverWebReview(submission, template, { uploadChatId, uploaded });
      await this.store.audit(0, 'submission.web_review', 'submission', submissionId, ip ?? null);
      return { id: submissionId, status: 'pending' };
    }

    if (!(await this.acquireSubmissionLease(submissionId))) throw new Error('这条投稿正在发布中，请稍后重试');
    let published;
    try {
      published = await this.publish(submission, template, { review: false });
      await this.releaseSubmissionLease(submissionId, { published: true });
    } catch (error) {
      await this.releaseSubmissionLease(submissionId);
      await this.store.updateSubmission(submissionId, { status: 'failed' });
      await this.store.audit(
        0,
        'submission.web_publish_failed',
        'submission',
        submissionId,
        String(error?.message ?? error),
      );
      throw error;
    }
    // 故意不删暂存的上传消息：file_id 在"源消息被删掉"之后能不能继续用，Telegram 没有承诺。
    // 留着它们（发送时已带 disable_notification）才能保证"撤下后重新发布 / 部分失败重试"仍然发得出去。
    const link = published.messageId
      ? linkForMessage(published.chatId, published.messageId, await this.ensureTargetChat())
      : null;
    await this.store.audit(0, 'submission.web', 'submission', submissionId, ip ?? null);
    return { id: submissionId, status: 'published', link };
  }

  /**
   * 网页投稿送审：媒体已经在审核会话里了，这里补一张带「通过 / 拒绝」的审核卡片。
   * 没配审核群就私聊发给每个管理员（媒体留在第一个管理员的私聊里）。
   */
  async deliverWebReview(submission, template, { uploadChatId, uploaded = [] }) {
    const text = this.webReviewText(submission, template);
    const keyboard = adminKeyboard(this.texts, submission.id, { review: true, web: true });
    // 记下媒体消息：重试/撤回要能找到它们（和 Telegram 审核流一致）
    await this.recordPublished(submission.id, uploadChatId, uploaded, 'published_media');
    const mediaPatch = {
      media_chat_id: uploaded.length > 0 ? uploadChatId : null,
      media_message_id: uploaded[0] ?? null,
    };
    const reviewChatId = await this.effectiveReviewChatId();

    if (reviewChatId !== null && reviewChatId === uploadChatId) {
      const sent = await this.tg.sendMessage(uploadChatId, text, {
        keyboard,
        replyTo: uploaded[0],
        threadId: null,
      });
      await this.recordPublished(submission.id, uploadChatId, [sent.message_id], 'published_text');
      await this.store.updateSubmission(submission.id, {
        ...mediaPatch,
        publish_chat_id: uploadChatId,
        publish_message_id: sent.message_id,
        message_ids: JSON.stringify([...uploaded, sent.message_id]),
      });
      return;
    }

    const adminIds = new Set(this.config.admins);
    try {
      for (const row of await this.store.listAdmins()) adminIds.add(row.user_id);
    } catch (error) {
      this.logger.warn?.(`读取管理员列表失败：${error?.message ?? error}`);
    }
    let delivered = 0;
    for (const adminId of adminIds) {
      let sent = null;
      let notifyError = null;
      try {
        sent = await this.tg.sendMessage(adminId, text, {
          keyboard,
          replyTo: adminId === uploadChatId ? uploaded[0] : undefined,
        });
      } catch (error) {
        notifyError = String(error?.message ?? error);
      }
      if (sent?.message_id) {
        delivered += 1;
        // 和审核群那条路径一样记下来：撤回/排查时才知道这条卡片是我们发的
        await this.recordPublished(submission.id, adminId, [sent.message_id], 'published_text');
      } else {
        // 私聊发卡片失败（最常见：管理员从没私聊过机器人）→ 记进审计，管理员随时能查到原因
        this.logger.warn?.(`给管理员 ${adminId} 发网页投稿审核卡片失败：${notifyError ?? '未知原因'}`);
        await this.store
          .audit(
            0,
            'submission.web_notify_failed',
            'submission',
            submission.id,
            `${adminId}: ${notifyError ?? '未知原因'}`,
          )
          .catch((error) => this.logger.warn?.(`写审计失败：${error?.message ?? error}`));
      }
      if (adminId === uploadChatId && sent?.message_id) {
        await this.store.updateSubmission(submission.id, {
          ...mediaPatch,
          publish_chat_id: adminId,
          publish_message_id: sent.message_id,
          message_ids: JSON.stringify([...uploaded, sent.message_id]),
        });
      }
    }
    if (delivered === 0) {
      // 机器人只能给"先私聊过它"的管理员发消息：一个都没发出去时投稿仍会进 /pending，
      // 但没人会被提醒——这里留一条明确的日志，方便排查"审核卡片去哪了"。
      this.logger.warn?.(
        `网页投稿 #${submission.id} 的审核卡片没能送达任何管理员（可能都还没私聊过机器人）。建议配置 ADMIN_CHAT_ID 审核群，或让管理员先给机器人发一次 /start。`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 网页投稿者的收件箱 / 邮件通知 / 匿名对话
  // ------------------------------------------------------------------

  /**
   * 事务邮件（Resend HTTP API）。没配 RESEND_API_KEY / MAIL_FROM 就静默跳过——
   * 网页投稿不依赖邮件也能用（收件箱页面照常能看到评论）。
   */
  async sendWebEmail(to, subject, text) {
    const apiKey = this.config.resendApiKey;
    const from = this.config.mailFrom;
    if (!apiKey || !from || !to) return false;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!response.ok) {
        this.logger.warn?.(`邮件发送失败（${response.status}）：${to}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn?.(`邮件发送异常：${error?.message ?? error}`);
      return false;
    }
  }

  /** 管理员的话 → 网页投稿者的收件箱（网页投稿没有私聊，只能落库 + 邮件提醒）。 */
  async deliverToWebAuthor(submission, text) {
    await this.store.addWebThreadMessage({ submissionId: submission.id, direction: 'to_author', text });
    const email = submission.data?.__email;
    if (email) {
      await this.sendWebEmail(
        email,
        `关于你的投稿 #${submission.id}`,
        `管理员给你留言：\n\n${text}\n\n回复：${this.config.options.webPublicUrl ?? ''}/inbox`,
      );
    }
    return true;
  }

  /** 网页投稿者给管理员留言 → 私聊提醒每个管理员。 */
  async deliverToAdminsFromWeb(submission, text) {
    await this.store.addWebThreadMessage({ submissionId: submission.id, direction: 'to_admin', text });
    await this.notifyAdmins(
      `💬 网页投稿 #${submission.id} 的作者留言：\n\n${escapeHtml(text)}\n\n` +
        `回复用：/admin → 📥 待审 → 找到这条 → 💬 回复投稿者`,
    );
    return true;
  }

  /** 网页收件箱：这个人（浏览器令牌）投过的稿 + 评论 + 管理员对话。 */
  async webInbox(viewerToken, limit = 10) {
    const rows = await this.store.listWebSubmissions(viewerToken, limit);
    const items = [];
    for (const row of rows) {
      // D1 返回的行里 data 是 JSON 字符串（getSubmission 走 hydrateSubmission，这里是批量查询）
      let data;
      try {
        data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {});
      } catch {
        data = {};
      }
      const comments = await this.store.listComments(row.id, 20, 0);
      const thread = await this.store.getWebThread(row.id, 50);
      const unread = await this.store.countUnreadWebThread(row.id);
      const seenAt = Number(data.__seenAt ?? 0);
      items.push({
        id: row.id,
        status: row.status,
        title: textOf(data.title) || textOf(data.body)?.slice(0, 40) || `投稿 #${row.id}`,
        createdAt: row.created_at,
        publishedLinkId: row.publish_chat_id && row.publish_message_id ? row.publish_message_id : null,
        mediaCount: attachmentsOf(data, this.config.templates[row.template_id] ?? {}).length,
        comments: comments
          .slice()
          .reverse()
          .map((comment) => ({
            messageId: comment.message_id,
            name: comment.kind === 'author_reply' ? '你' : comment.author_name || '有人',
            text: comment.text ?? '',
            kind: comment.kind ?? 'user',
            parentAuthor: comment.parent_author_name ?? null,
            createdAt: comment.created_at,
            isMine: comment.kind === 'author_reply',
          })),
        unreadComments: comments.filter(
          (comment) => Number(comment.created_at) > seenAt && comment.kind !== 'author_reply',
        ).length,
        thread: thread.map((message) => ({
          direction: message.direction,
          text: message.text,
          createdAt: message.created_at,
        })),
        unreadThread: unread,
      });
      await this.store.touchWebSeen(row.id, nowSeconds());
      await this.store.markWebThreadSeenByAuthor(row.id);
    }
    return items;
  }

  /** 网页投稿者回复某条评论（以"作者回复"发到评论区）。 */
  async replyToCommentAsWebAuthor(submission, { commentMessageId, text }) {
    const comment = await this.store.getComment(submission.publishChatId, commentMessageId);
    if (!comment) throw new Error('这条评论已经不在了');
    // 归属校验：同一张已发布消息下面挂着**所有**投稿的评论，只按 (chat, message_id)
    // 取出来是不够的——拿自己的投稿 id 配别人评论的 message_id，就能以"作者回复"的
    // 身份挂到别人的评论下面。submission_id 这一列本来就有，只是一直没用。
    if (Number(comment.submission_id) !== Number(submission.id)) throw new Error('这条评论不属于这篇投稿');
    const body = this.texts('authorCommentReply', { text: escapeHtml(text) });
    const sent = await this.tg.sendMessage(comment.chat_id, body, {
      replyTo: comment.message_id,
      threadId: comment.thread_id ?? undefined,
    });
    await this.store.rememberComment({
      chatId: comment.chat_id,
      messageId: sent.message_id,
      submissionId: submission.id,
      threadId: comment.thread_id ?? null,
      authorId: null,
      authorName: this.texts('commentAuthorLabel'),
      text,
      parentMessageId: comment.message_id,
      parentAuthorName: this.commentParentLabel(comment),
      kind: 'author_reply',
    });
    return true;
  }

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------

  async reply(chatId, text, { keyboard, raw = false, threadId, replyTo } = {}) {
    const body = raw ? text : escapeHtml(text);
    return this.tg.sendMessage(chatId, body, { keyboard, threadId, replyTo });
  }

  async notifyAdmins(text) {
    const ids = new Set(this.config.admins);
    try {
      for (const row of await this.store.listAdmins()) ids.add(row.user_id);
    } catch (error) {
      this.logger.warn?.(`读取管理员列表失败：${error?.message ?? error}`);
    }
    for (const adminId of ids) await this.tryReply(adminId, text, { raw: true });
  }

  async tryReply(chatId, text, { raw = true, keyboard, threadId, replyTo } = {}) {
    try {
      return await this.reply(chatId, text, { keyboard, raw, threadId, replyTo });
    } catch (error) {
      this.logger.warn?.(`给 ${chatId} 发送消息失败：${error?.message ?? error}`);
      return null;
    }
  }

  async tryDelete(chatId, messageId) {
    if (!messageId) return false;
    try {
      await this.tg.deleteMessage(chatId, messageId);
      return true;
    } catch (error) {
      this.logger.warn?.(`删除消息失败：${error?.message ?? error}`);
      return false;
    }
  }

  async tryReact(chatId, messageId, emoji) {
    try {
      await this.tg.setMessageReaction(chatId, messageId, emoji);
    } catch (error) {
      this.logger.warn?.(`设置表情回执失败：${error?.message ?? error}`);
    }
  }

  async tryEditMarkup(chatId, messageId, text, { keyboard, removeKeyboard = false } = {}) {
    if (!text || !messageId) return false;
    try {
      await this.tg.editMessageText(chatId, messageId, text, { keyboard, removeKeyboard });
      return true;
    } catch (error) {
      this.logger.warn?.(`编辑消息失败：${error?.message ?? error}`);
      return false;
    }
  }

  async answer(callbackQueryId, options) {
    try {
      return await this.tg.answerCallbackQuery(callbackQueryId, options);
    } catch (error) {
      this.logger.warn?.(`回执按钮失败：${error?.message ?? error}`);
      return null;
    }
  }
}
