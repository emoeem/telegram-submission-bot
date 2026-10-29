/** 读取 Cloudflare 环境变量，组装成运行时配置。 */

import { createTexts } from './texts.js';

export const DEFAULT_TEMPLATE = {
  name: '默认投稿',
  steps: [
    {
      id: 'category',
      type: 'choice',
      prompt: '这次投稿属于哪一类？',
      options: ['图片分享', '文字分享', '提问求助', '其他'],
      label: '分类',
    },
    {
      id: 'title',
      type: 'text',
      prompt: '给这次投稿起个标题？（没有就点跳过）',
      required: false,
      max_length: 80,
      label: '标题',
    },
    {
      id: 'body',
      type: 'text',
      prompt: '写正文吧，想说的话都可以直接发给我',
      required: true,
      max_length: 2000,
      label: '正文',
    },
    {
      id: 'photos',
      type: 'media',
      prompt: '要配图或者附件吗？图片、视频、文件、语音、位置都行（没有就点跳过）',
      required: false,
      label: '图片',
    },
    {
      id: 'author',
      type: 'choice',
      prompt: '发布的时候怎么署名？',
      options: ['匿名投稿', '显示我的昵称', '自定义署名'],
      label: '署名方式',
    },
    {
      id: 'signature',
      type: 'text',
      prompt: '请输入想显示的署名',
      required: true,
      max_length: 32,
      label: '署名',
      show_if: { step: 'author', equals: '自定义署名' },
    },
    {
      id: 'contact',
      type: 'text',
      prompt: '最后一步：留个联系方式吗？（可跳过）',
      required: false,
      max_length: 64,
      label: '联系方式',
    },
  ],
};

const STEP_TYPES = new Set(['text', 'choice', 'media']);

export const DEFAULT_REJECT_REASONS = [
  '内容与本群主题无关',
  '广告或推广内容',
  '含违规内容',
  '重复投稿',
  '内容太乱，请整理后再投',
];

export class ConfigError extends Error {}

function parseJsonEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw new ConfigError(`环境变量 ${name} 不是合法 JSON：${error.message}`);
  }
}

function boolEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(value) ? value : fallback;
}

function chatIdEnv(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function parseAdmins(env) {
  const raw = String(env.ADMIN_IDS ?? '');
  return raw
    .split(/[,\s]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((value) => Number.isFinite(value));
}

/** 逗号、竖线、换行分隔的列表，用来配置敏感词和驳回理由。 */
function parseList(raw) {
  return String(raw ?? '')
    .split(/[,\n|、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateTemplate(templateId, template) {
  if (!template || typeof template !== 'object') {
    throw new ConfigError(`模板 ${templateId} 必须是对象`);
  }
  const steps = template.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ConfigError(`模板 ${templateId} 至少需要一个步骤（steps）`);
  }
  const ids = new Set();
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') {
      throw new ConfigError(`模板 ${templateId} 第 ${index + 1} 个步骤不是对象`);
    }
    if (!step.id || typeof step.id !== 'string') {
      throw new ConfigError(`模板 ${templateId} 第 ${index + 1} 个步骤缺少 id`);
    }
    // step.id 会进入 inline 按钮的 callback_data（Telegram 上限 64 字节），必须短且安全
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(step.id)) {
      throw new ConfigError(
        `模板 ${templateId} 的步骤 id 只能用 1-24 位字母/数字/下划线/连字符（它会被放进按钮数据）：${step.id}`,
      );
    }
    if (ids.has(step.id)) throw new ConfigError(`模板 ${templateId} 步骤 id 重复：${step.id}`);
    ids.add(step.id);
    const type = step.type ?? 'text';
    if (!STEP_TYPES.has(type)) {
      throw new ConfigError(`步骤 ${step.id} 的 type 只能是 text / choice / media`);
    }
    if (!step.prompt) throw new ConfigError(`步骤 ${step.id} 缺少 prompt（提问文案）`);
    if (type === 'choice') {
      if (!Array.isArray(step.options) || step.options.length === 0) {
        throw new ConfigError(`选项步骤 ${step.id} 需要至少一个 options`);
      }
      if (step.options.length > 8) {
        throw new ConfigError(`选项步骤 ${step.id} 最多 8 个选项`);
      }
    }
  });
  for (const step of steps) {
    const cond = step.show_if;
    if (cond && !ids.has(cond.step)) {
      throw new ConfigError(`步骤 ${step.id} 的 show_if 指向了不存在的步骤 ${cond.step}`);
    }
  }
}

export function loadConfig(env) {
  const templates = parseJsonEnv(env, 'TEMPLATES_JSON', null) ?? { default: DEFAULT_TEMPLATE };
  for (const [id, template] of Object.entries(templates)) validateTemplate(id, template);
  if (Object.keys(templates).length === 0) throw new ConfigError('至少需要配置一个模板');

  const config = {
    token: String(env.BOT_TOKEN ?? '').trim(),
    apiBase: String(env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/, ''),
    webhookSecret: String(env.WEBHOOK_SECRET ?? '').trim(),
    targetChatId: chatIdEnv(env, 'TARGET_CHAT_ID'),
    adminChatId: chatIdEnv(env, 'ADMIN_CHAT_ID'),
    topicId: chatIdEnv(env, 'TOPIC_ID'),
    mainGroupUrl: String(env.MAIN_GROUP_URL ?? '').trim(),
    admins: parseAdmins(env),
    // 网页投稿被中继（Vercel/自建反代）转发时校验来访身份用的共享密钥；留空则只信 cf-connecting-ip
    relaySecret: String(env.RELAY_SECRET ?? '').trim(),
    // 后台管理端审核网页投稿用的共享密钥（`npx wrangler secret put REVIEW_API_SECRET`）。
    // 留空 = 管理端审核接口整体关闭，只保留 Telegram 群里的按钮审核 —— 这是
    // fail-closed 的方向：没配密钥时不能靠"没鉴权"就等于"随便谁都能审"。
    reviewSecret: String(env.REVIEW_API_SECRET ?? '').trim(),
    // 网页投稿者的评论通知邮件（Resend，和问卷平台同一套）；不配就只靠网页收件箱
    resendApiKey: String(env.RESEND_API_KEY ?? '').trim(),
    mailFrom: String(env.MAIL_FROM ?? '').trim(),
    relayIpHeader: String(env.RELAY_IP_HEADER ?? 'x-vercel-proxied-for').trim() || 'x-vercel-proxied-for',
    templates,
    texts: createTexts(parseJsonEnv(env, 'TEXTS_JSON', null)),
    options: {
      requireReview: boolEnv(env, 'REQUIRE_REVIEW', false),
      deleteUserMessages: boolEnv(env, 'DELETE_USER_MESSAGES', true),
      showStepHeader: boolEnv(env, 'SHOW_STEP_HEADER', true),
      maxPhotos: Math.max(1, intEnv(env, 'MAX_PHOTOS', 9)),
      maxAttachments: Math.max(1, intEnv(env, 'MAX_ATTACHMENTS', intEnv(env, 'MAX_PHOTOS', 10))),
      maxTextLength: Math.max(1, intEnv(env, 'MAX_TEXT_LENGTH', 2000)),
      // 未完成的草稿多久自动作废（秒），0 = 永不过期
      sessionTtlSeconds: Math.max(0, intEnv(env, 'SESSION_TTL_SECONDS', 604800)),
      // 每个用户最多挂起几份草稿
      maxDrafts: Math.max(1, intEnv(env, 'MAX_DRAFTS', 5)),
      // 是否接 Telegram 官方评论区（讨论组里对已发布投稿的评论）
      discussionComments: boolEnv(env, 'DISCUSSION_COMMENTS', true),
      // 评论通知的聚合窗口（秒）与单条通知最多列几条
      commentNotifyCooldownSeconds: Math.max(0, intEnv(env, 'COMMENT_NOTIFY_COOLDOWN_SECONDS', 120)),
      commentNotifyMax: Math.max(1, intEnv(env, 'COMMENT_NOTIFY_MAX', 5)),
      rateLimitCount: Math.max(0, intEnv(env, 'RATE_LIMIT_COUNT', 5)),
      rateLimitWindowSeconds: Math.max(0, intEnv(env, 'RATE_LIMIT_WINDOW_SECONDS', 600)),
      tag: String(env.TAG ?? '#投稿'),
      footer: String(env.FOOTER ?? ''),
      anonymousLabel: String(env.ANONYMOUS_LABEL ?? '匿名投稿'),
      // 防滥用
      captcha: boolEnv(env, 'CAPTCHA', false),
      blockLinks: boolEnv(env, 'BLOCK_LINKS', false),
      bannedWords: parseList(env.BANNED_WORDS),
      duplicateWindowSeconds: Math.max(0, intEnv(env, 'DUPLICATE_WINDOW_SECONDS', 0)),
      newUserCooldownSeconds: Math.max(0, intEnv(env, 'NEW_USER_COOLDOWN_SECONDS', 0)),
      // 审核
      rejectReasons: parseList(env.REJECT_REASONS).length > 0 ? parseList(env.REJECT_REASONS) : DEFAULT_REJECT_REASONS,
      autoHashtags: boolEnv(env, 'AUTO_HASHTAGS', true),
      publishTemplate: String(env.PUBLISH_TEMPLATE ?? '{tag} · {category}\n\n{title}\n{body}\n\n{meta}\n{footer}'),
      // 网页投稿（/submit）：不开 Telegram 也能投，给国内用户用
      webEnabled: boolEnv(env, 'WEB_ENABLED', true),
      // 网页投稿默认**必须审核**：没有 Telegram 身份，直接自动发布等于开了个公开灌水位
      webRequireReview: boolEnv(env, 'WEB_REQUIRE_REVIEW', true),
      webRateLimitCount: Math.max(0, intEnv(env, 'WEB_RATE_LIMIT_COUNT', 3)),
      webRateLimitWindowSeconds: Math.max(0, intEnv(env, 'WEB_RATE_LIMIT_WINDOW_SECONDS', 3600)),
      webMaxFiles: Math.max(0, intEnv(env, 'WEB_MAX_FILES', 6)),
      webMaxFileMb: Math.max(1, intEnv(env, 'WEB_MAX_FILE_MB', 10)),
      // 全天硬上限：单 IP 限流挡不住 IP 池，这一道是"无论来多少 IP，一天最多收这么多"。
      // 0 = 关闭（不推荐）。免费额度是 10 万次请求/天，这里故意压到远低于打满的量级。
      webDailyLimit: Math.max(0, intEnv(env, 'WEB_DAILY_LIMIT', 300)),
      // 积压上限：待审稿件堆到这个数就停止收新稿。被刷时 pending 只增不减，闸门会一直关着；
      // 正常业务里管理员审核后自然回落。0 = 关闭。
      webPendingLimit: Math.max(0, intEnv(env, 'WEB_PENDING_LIMIT', 100)),
      // 填表最短用时（秒）：比这还快的提交基本是脚本
      webMinFillSeconds: Math.max(0, intEnv(env, 'WEB_MIN_FILL_SECONDS', 3)),
      webTitle: String(env.WEB_TITLE ?? '').trim(),
      webIntro: String(env.WEB_INTRO ?? '').trim(),
      // 对外的网页投稿地址（例如经中继后的 https://<your-domain>/submit）：
      // 配了就在机器人菜单/欢迎语里显示入口，留空则不显示。
      webPublicUrl: String(env.WEB_PUBLIC_URL ?? '').trim(),
    },
  };

  if (config.topicId !== null && config.topicId <= 0) config.topicId = null;
  // 审核群必须是独立配置的；绝不能回退到公开目标群，否则未审核的草稿会直接出现在群里。
  config.reviewChatId = config.adminChatId ?? null;
  return config;
}

/** 启动自检：返回问题列表，空数组表示可以跑。 */
export function checkConfig(config) {
  const problems = [];
  if (!config.token) problems.push('缺少 BOT_TOKEN（用 `npx wrangler secret put BOT_TOKEN` 设置）');
  if (config.targetChatId === null) {
    problems.push('还没设置投稿发布群：把我拉进群里，在群里发 /bind 就能设定（也可以填 wrangler.toml）');
  }
  if (config.admins.length === 0) problems.push('缺少 ADMIN_IDS（私聊机器人发 /myid 获取）');
  // webhook secret 未配置时，任何人都能 POST /webhook 伪造 Telegram update
  //（包括冒充管理员身份）。不阻断启动（老部署可能还没配），但 /diag 与启动
  // 自检必须喊出来。
  if (!config.webhookSecret) {
    problems.push(
      '强烈建议设置 WEBHOOK_SECRET（`npx wrangler secret put WEBHOOK_SECRET`，再让 Telegram 以 secret_token 调 webhook）：' +
        '没有它，伪造的 Telegram 消息会被当作真实投稿/管理员指令处理',
    );
  }
  if (config.options.requireReview && config.reviewChatId === null) {
    problems.push(
      '开启了审核模式，但没有独立的审核群（ADMIN_CHAT_ID）。审核消息不能发到公开的发布群，' +
        '否则未审核的草稿会直接被人看到；请设置 ADMIN_CHAT_ID，或先执行 /review off',
    );
  }
  if (
    config.options.requireReview &&
    config.reviewChatId !== null &&
    config.targetChatId !== null &&
    config.reviewChatId === config.targetChatId
  ) {
    problems.push('审核群和发布群是同一个，未审核的草稿会直接出现在公开群里；请单独给 ADMIN_CHAT_ID 配一个审核群');
  }
  return problems;
}
