/**
 * 网页投稿的 HTTP 层：/submit 页面、验证题、/api/submit 提交接口。
 *
 * 设计取舍：
 * - 页面和接口都由这个 Worker 直接提供，不依赖任何外部 CDN（国内也能打开）；
 * - 图片/视频不在服务端落地：直接上传给 Telegram 拿 file_id，和 Telegram 投稿共用同一套发布逻辑；
 * - 网页没有 Telegram 身份，默认**必须审核**（WEB_REQUIRE_REVIEW=1），否则就是个公开灌水位。
 */

import { escapeHtml, nowSeconds, randomNonce, truncate } from './utils.js';
import { safeEqual, resolveClientIp } from './client-ip.js';
import { renderInboxPage, renderSubmitPage } from './web-page.js';
import { visibleSteps } from './wizard.js';

const FORM_TOKEN_TTL_SECONDS = 1800;
/** 填表最短用时：比这还快的提交基本是脚本（也顺手挡住"打开就提交"的误触）。 */
const MIN_FILL_SECONDS = 3;
const MAX_FIELD_CHARS = 5000;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 表单定义：网页前端（含并进问卷前端后的 React 页面）照着它渲染，避免把步骤写死在两处。 */
function submitFormSchema(config, template) {
  const totalLimit = config.options.maxTextLength;
  return {
    title: config.options.webTitle || '📮 投稿',
    intro:
      config.options.webIntro ||
      '在这里直接投稿，不用注册、也不用装 Telegram。\n提交后会先经过管理员审核，通过后才会发布。',
    captcha: config.options.captcha,
    maxFiles: config.options.webMaxFiles,
    maxFileMb: config.options.webMaxFileMb,
    minFillSeconds: config.options.webMinFillSeconds,
    submitUrl: '/api/submit',
    captchaUrl: '/api/submit/captcha',
    inboxUrl: '/submit/inbox',
    mainGroupUrl: config.mainGroupUrl || null,
    steps: template.steps.map((step) => ({
      id: step.id,
      type: step.type,
      label: step.label ?? step.id,
      prompt: step.prompt ?? '',
      options: Array.isArray(step.options) ? step.options : null,
      required: step.required !== false,
      maxLength: Math.min(step.max_length ?? totalLimit, totalLimit),
      showIf: step.show_if ? { step: step.show_if.step, equals: step.show_if.equals ?? '' } : null,
    })),
  };
}

async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 简单算式验证题：挡住脚本，不追求"证明你是人"。 */
function makeQuestion() {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const plus = Math.random() < 0.6;
  return plus ? { question: `${a} + ${b}`, answer: String(a + b) } : { question: `${a} × ${b}`, answer: String(a * b) };
}

/** 验证令牌：无状态（HMAC 签名），不需要往 D1 写挑战记录。 */
async function issueFormToken(secret, { captcha, now = nowSeconds() }) {
  const puzzle = captcha ? makeQuestion() : null;
  const nonce = randomNonce(8);
  const expiresAt = now + FORM_TOKEN_TTL_SECONDS;
  const signature = await hmacHex(secret, `${expiresAt}.${nonce}.${puzzle ? puzzle.answer : ''}`);
  return {
    token: `${expiresAt}.${nonce}.${signature}`,
    question: puzzle ? puzzle.question : null,
    issued_at: now,
    expires_in: FORM_TOKEN_TTL_SECONDS,
  };
}

async function verifyFormToken(
  secret,
  token,
  answer,
  { captcha, minFillSeconds = MIN_FILL_SECONDS, now = nowSeconds() } = {},
) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'expired' };
  const [rawExpires, nonce, signature] = parts;
  const expiresAt = Number.parseInt(rawExpires, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return { ok: false, reason: 'expired' };
  const issuedAt = expiresAt - FORM_TOKEN_TTL_SECONDS;
  if (minFillSeconds > 0 && now - issuedAt < minFillSeconds) return { ok: false, reason: 'too_fast' };
  const expected = await hmacHex(
    secret,
    `${expiresAt}.${nonce}.${
      captcha
        ? String(answer ?? '')
            .trim()
            .toLowerCase()
        : ''
    }`,
  );
  if (!safeEqual(expected, signature)) return { ok: false, reason: 'wrong_answer' };
  return { ok: true, nonce, expiresAt };
}

/** 表单字段 → 投稿 data（结构与 Telegram 向导一致，方便复用渲染/审核/编辑）。 */
function collectFields(config, template, form) {
  const data = {};
  const errors = {};
  const allowedKeys = new Set(template.steps.map((step) => step.id));
  const totalLimit = config.options.maxTextLength;

  for (const step of template.steps) {
    if (step.type === 'media') continue;
    const raw = form.get(`step:${step.id}`);
    const value = typeof raw === 'string' ? raw.trim() : '';
    const label = step.label ?? step.prompt ?? '这一项';
    const visible = visibleSteps(template, data).some((item) => item.id === step.id);
    if (!visible) continue;

    if (!value) {
      if (step.required !== false) errors[step.id] = `${label}：请填写`;
      continue;
    }
    if (value.length > MAX_FIELD_CHARS) {
      errors[step.id] = `${label}：内容太长了`;
      continue;
    }
    if (step.type === 'choice') {
      if (!(step.options ?? []).includes(value)) {
        errors[step.id] = `${label}：选项不正确`;
        continue;
      }
      data[step.id] = value;
      continue;
    }
    const limit = Math.min(step.max_length ?? totalLimit, totalLimit);
    if (value.length > limit) {
      errors[step.id] = `${label}：最多 ${limit} 字`;
      continue;
    }
    // 正文里的换行原样保留；html 已经过转义，直接进发布模板不会注入
    data[step.id] = { plain: value, html: escapeHtml(value) };
  }

  // 网页没有 Telegram 昵称：选了「显示我的昵称」就得自己填一个
  const nickname = String(form.get('nickname') ?? '').trim();
  if (nickname.length > 32) {
    errors.nickname = '昵称：最多 32 字';
  } else if (nickname) {
    data.__nickname = nickname;
  }
  if (data.author === '显示我的昵称' && !nickname) {
    errors.nickname = '昵称：选了「显示我的昵称」，请填昵称或改成匿名';
  }
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key) && !key.startsWith('__')) delete data[key];
  }
  return { data, errors };
}

/** 邮箱只要长得像就行（不做真实性验证，通知发不出去不影响投稿）。 */
function normalizeEmail(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 120) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : null;
}

/** 校验上传的文件并归一成 {kind, file, name}。 */
function collectFiles(config, template, form) {
  const mediaStep = template.steps.find((step) => step.type === 'media');
  const files = [];
  const errors = {};
  if (!mediaStep) return { files, errors, stepId: null };

  const raw = form.getAll(`file:${mediaStep.id}`);
  const picked = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof item.arrayBuffer === 'function' && item.size > 0) picked.push(item);
  }
  if (picked.length > config.options.webMaxFiles) {
    errors[mediaStep.id] = `${mediaStep.label ?? '附件'}：最多 ${config.options.webMaxFiles} 个文件`;
    return { files, errors, stepId: mediaStep.id };
  }
  const maxBytes = config.options.webMaxFileMb * 1024 * 1024;
  for (const file of picked) {
    const type = String(file.type ?? '');
    const kind = type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : 'document';
    const limit =
      kind === 'photo'
        ? Math.min(maxBytes, PHOTO_MAX_BYTES)
        : kind === 'video'
          ? Math.min(maxBytes, VIDEO_MAX_BYTES)
          : maxBytes;
    if (file.size > limit) {
      errors[mediaStep.id] = `${mediaStep.label ?? '附件'}：单个文件不能超过 ${Math.round(limit / 1024 / 1024)} MB`;
      return { files, errors, stepId: mediaStep.id };
    }
    files.push({ kind, file, name: typeof file.name === 'string' ? file.name : undefined });
  }
  return { files, errors, stepId: mediaStep.id };
}

/**
 * 限流分桶用的时间窗口序号。
 *
 * 直接用真实时钟在测试里是个坑：一次用例跨过整点边界（xx:59:59.99 →
 * xx:00:00.01）就落到下一个桶，前面刚攒的计数清零，本该 429 的请求变 200 ——
 * 每小时随机炸一次的 flaky，炸的时候看起来像业务逻辑坏了。这里留一个和
 * TELEGRAM_FETCH 同风格的注入点：env.WEB_RATE_LIMIT_CLOCK 是返回秒数的函数，
 * 只有测试会设它；生产环境是 undefined，照常走 nowSeconds()。
 */
function rateLimitWindow(env, windowSeconds) {
  const injected = env?.WEB_RATE_LIMIT_CLOCK;
  const now = typeof injected === 'function' ? Math.floor(Number(injected())) : nowSeconds();
  return Math.floor(now / windowSeconds);
}

/**
 * 当天的计数桶：{key, windowStart}。用作"全天硬上限"的计数位。
 * 和 rateLimitWindow 一样留了 WEB_RATE_LIMIT_CLOCK 注入点，测试里才能把日期钉死；
 * 跨日边界会导致桶换新、计数清零，这和小时桶是同一类问题。
 * key 与 windowStart 必须同源算出来，否则测试里注入的时钟会和 window_start 对不上。
 */
function dailyBucket(env) {
  const injected = env?.WEB_RATE_LIMIT_CLOCK;
  const now = typeof injected === 'function' ? Math.floor(Number(injected())) : nowSeconds();
  const windowStart = Math.floor(now / 86400) * 86400;
  return { key: `global-day:${new Date(windowStart * 1000).toISOString().slice(0, 10)}`, windowStart };
}

/**
 * 网页路由。返回 null 表示"不是网页投稿的路径"，交回给 index.js 继续路由。
 */
export async function handleWebRequest(request, { config, bot, env }) {
  const url = new URL(request.url);
  const isPage = url.pathname === '/submit' || url.pathname === '/submit/' || url.pathname === '/submit/inbox';
  const isApi = url.pathname === '/api/submit' || url.pathname.startsWith('/api/submit/');
  if (!isPage && !isApi) return null;
  if (!config.options.webEnabled) return new Response('Not Found', { status: 404 });
  if (!env.DB) return jsonResponse({ ok: false, error: '缺少 D1 绑定' }, 500);

  const templateId = config.templates.default ? 'default' : Object.keys(config.templates)[0];
  const template = config.templates[templateId];
  const secret = config.webhookSecret || config.token;
  const captcha = config.options.captcha && Boolean(secret);

  if (isPage) {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method Not Allowed', { status: 405 });
    let botUsername = null;
    try {
      botUsername = (await bot.ensureBot()).username || null;
    } catch (error) {
      bot.logger?.warn?.(`读取机器人信息失败：${error?.message ?? error}`);
    }
    if (url.pathname.startsWith('/submit/inbox')) return htmlResponse(renderInboxPage({ config }));
    return htmlResponse(renderSubmitPage({ config, template, botUsername }));
  }

  if (url.pathname === '/api/submit/form') {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return jsonResponse({ ok: true, form: submitFormSchema(config, template) });
  }

  if (url.pathname === '/api/submit/captcha') {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    if (!secret) return jsonResponse({ ok: false, error: '服务端还没配置 WEBHOOK_SECRET，无法发放验证令牌' }, 500);
    return jsonResponse(await issueFormToken(secret, { captcha }));
  }

  if (url.pathname === '/api/submit/inbox') {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    // 与收件箱写操作同一个按 IP 限流桶：这是唯一无需任何令牌就触碰 submissions
    // 表的读端点，且查询按 __viewer 全表扫描（rows-read 随表线性涨），不限流
    // 等于把 D1 读取量免费送人。
    const limited = await inboxRateLimit(request, { config, bot, env });
    if (limited) return limited;
    const viewer = normalizeViewer(url.searchParams.get('t'));
    if (!viewer) return jsonResponse({ ok: false, error: '缺少身份令牌' }, 400);
    const items = await bot.webInbox(viewer);
    return jsonResponse({ ok: true, items, webSubmitUrl: bot.publicWebSubmitUrl() ?? '/submit' });
  }

  if (url.pathname === '/api/submit/reply' || url.pathname === '/api/submit/message') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleInboxAction(request, url, { config, bot, env });
  }

  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  return handleSubmit(request, { config, bot, template, templateId, secret, captcha, env });
}

/** 浏览器身份令牌：只接受我们发出去的随机 hex，避免被拿去做奇怪的查询。 */
function normalizeViewer(raw) {
  const value = String(raw ?? '').trim();
  return /^[a-f0-9]{16,64}$/i.test(value) ? value.toLowerCase() : null;
}

/**
 * 收件箱（读 GET /api/submit/inbox 与写 reply/message 共用）的按 IP 限流。
 * 返回 Response 表示已限流，返回 null 放行。
 */
async function inboxRateLimit(request, { config, bot, env }) {
  const ip = resolveClientIp(request, { relaySecret: config.relaySecret, relayHeader: config.relayIpHeader });
  const { webRateLimitCount, webRateLimitWindowSeconds } = config.options;
  if (webRateLimitCount > 0 && webRateLimitWindowSeconds > 0) {
    if (!ip) {
      bot.logger?.warn?.('网页收件箱：拿不到访客 IP，本次跳过按 IP 限流（依赖全天总闸）');
      return null;
    }
    const window = rateLimitWindow(env, webRateLimitWindowSeconds);
    try {
      // 先原子自增再看结果：以前是"先读、干完整件事再写"，并发请求全都读到旧计数、
      // 全都放行，限流等于没有。bumpWebRateLimit 的单条 UPSERT 是原子的。
      const used = await bot.store.bumpWebRateLimit(`inbox:${ip}:${window}`, window);
      if (used > webRateLimitCount * 6) return jsonResponse({ ok: false, error: '操作太频繁了，请稍后再试' }, 429);
    } catch {
      /* 老库缺表时降级为不限流 */
    }
  }
  return null;
}

/** 收件箱里的两个写操作：回复某条评论 / 给管理员留言。 */
async function handleInboxAction(request, url, { config, bot, env }) {
  const limited = await inboxRateLimit(request, { config, bot, env });
  if (limited) return limited;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: '请求格式不对' }, 400);
  }
  const viewer = normalizeViewer(body?.viewer);
  const text = String(body?.text ?? '').trim();
  const submissionId = Number.parseInt(body?.submissionId ?? '', 10);
  if (!viewer || !Number.isFinite(submissionId)) return jsonResponse({ ok: false, error: '缺少身份或投稿编号' }, 400);
  if (!text) return jsonResponse({ ok: false, error: '内容不能为空' }, 422);
  if (text.length > 800) return jsonResponse({ ok: false, error: '太长了，请控制在 800 字以内' }, 422);

  const submission = await bot.store.getSubmission(submissionId);
  if (!submission || submission.data?.__source !== 'web' || submission.data?.__viewer !== viewer) {
    return jsonResponse({ ok: false, error: '找不到这条投稿' }, 404);
  }

  try {
    if (url.pathname === '/api/submit/reply') {
      const commentMessageId = Number.parseInt(body?.commentMessageId ?? '', 10);
      if (!Number.isFinite(commentMessageId)) return jsonResponse({ ok: false, error: '缺少评论编号' }, 400);
      await bot.replyToCommentAsWebAuthor(submission, { commentMessageId, text });
      return jsonResponse({ ok: true });
    }
    await bot.deliverToAdminsFromWeb(submission, text);
    return jsonResponse({ ok: true });
  } catch (error) {
    // 只记日志、不把内部异常原文回给访客：那里面会带 SQL 片段和 Telegram 的原始错误
    bot.logger?.error?.('网页收件箱操作失败：', String(error?.message ?? error));
    return jsonResponse({ ok: false, error: '操作没成功，请稍后再试' }, 400);
  }
}

async function handleSubmit(request, { config, bot, template, templateId, secret, captcha, env }) {
  const ip = resolveClientIp(request, { relaySecret: config.relaySecret, relayHeader: config.relayIpHeader });
  const { webRateLimitCount, webRateLimitWindowSeconds } = config.options;

  // 先看 Content-Length：超大请求体不必先读进内存再拒绝（Worker 内存有限）
  const budgetBytes = (config.options.webMaxFiles * config.options.webMaxFileMb + 1) * 1024 * 1024;
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > budgetBytes) {
    return jsonResponse(
      { ok: false, error: `文件太多了：一次投稿总大小不能超过 ${Math.round(budgetBytes / 1024 / 1024)} MB` },
      413,
    );
  }

  // 按 IP 的只读预检：正式的 bump+check 在表单解析之后（校验失败不烧次数），
  // 但 formData() 会把整个 multipart 读进内存——chunked 上传不带 Content-Length，
  // 上面的 413 预检拦不住；纯消耗流量（从不成功）也永远碰不到后面的闸。
  // 这里只读不写：超限的 IP 连 body 都不读直接 429，正常用户的额度语义不变。
  if (webRateLimitCount > 0 && webRateLimitWindowSeconds > 0 && ip) {
    const window = rateLimitWindow(env, webRateLimitWindowSeconds);
    try {
      const used = await bot.store.getWebRateLimit(`web:${ip}:${window}`);
      if (used >= webRateLimitCount) {
        const minutes = Math.max(1, Math.ceil(webRateLimitWindowSeconds / 60));
        return jsonResponse({ ok: false, error: `提交太频繁了，请 ${minutes} 分钟后再试` }, 429);
      }
    } catch {
      /* 老库缺表时降级为不限流 */
    }
  }

  // 全天硬上限 + 积压上限：这两道在解析表单之前，打满后连 body 都不读，省 CPU 和内存。
  // 单 IP 限流挡不住换 IP 的脚本，所以必须有一个与 IP 无关的总闸。
  const { webDailyLimit, webPendingLimit } = config.options;
  if (webDailyLimit > 0) {
    const day = dailyBucket(env);
    let usedToday = 0;
    try {
      usedToday = await bot.store.getWebRateLimit(day.key);
    } catch (error) {
      bot.logger?.warn?.(`全天限额读不到：${error?.message ?? error}`);
    }
    if (usedToday >= webDailyLimit) {
      return jsonResponse({ ok: false, error: '今天的投稿量已满，请明天再来' }, 429);
    }
  }
  if (webPendingLimit > 0) {
    try {
      const pending = await bot.store.countPendingSubmissions();
      if (pending >= webPendingLimit) {
        return jsonResponse({ ok: false, error: '待审核的投稿已经排满了，请稍后再来' }, 429);
      }
    } catch (error) {
      bot.logger?.warn?.(`待审积压数读不到：${error?.message ?? error}`);
    }
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ ok: false, error: '表单数据读不出来，请重试' }, 400);
  }

  // content-length 可以被 chunked 上传绕开，所以解析完再按真实体积复核一次
  const actualBytes = [...form.values()]
    .filter((item) => item && typeof item === 'object' && typeof item.size === 'number')
    .reduce((sum, item) => sum + item.size, 0);
  if (actualBytes > budgetBytes) {
    return jsonResponse(
      { ok: false, error: `文件太多了：一次投稿总大小不能超过 ${Math.round(budgetBytes / 1024 / 1024)} MB` },
      413,
    );
  }

  // 蜜罐：正常用户看不到这个字段，填了就是脚本
  if (String(form.get('website') ?? '').trim()) {
    await bot.logger?.warn?.('网页投稿：蜜罐字段被填写，已丢弃');
    return jsonResponse({ ok: false, error: '提交失败，请刷新页面重试' }, 400);
  }

  if (!secret) return jsonResponse({ ok: false, error: '服务端配置不完整（缺少 WEBHOOK_SECRET）' }, 500);
  const verification = await verifyFormToken(secret, form.get('token'), form.get('captcha'), {
    captcha,
    minFillSeconds: config.options.webMinFillSeconds,
  });
  if (!verification.ok) {
    const messages = {
      expired: '验证已过期，请刷新页面重新填写',
      too_fast: '提交得太快了，请确认内容后再提交',
      wrong_answer: '验证答案不对，请重新算一次',
    };
    return jsonResponse({ ok: false, error: messages[verification.reason] ?? '验证没通过' }, 403);
  }

  const { data, errors } = collectFields(config, template, form);
  const nickname = String(form.get('nickname') ?? '').trim();
  const files = collectFiles(config, template, form);
  Object.assign(errors, files.errors);
  if (Object.keys(errors).length > 0) return jsonResponse({ ok: false, errors }, 422);

  if (webRateLimitCount > 0 && webRateLimitWindowSeconds > 0) {
    if (!ip) {
      bot.logger?.warn?.('网页投稿：拿不到访客 IP，本次跳过按 IP 限流（依赖全天总闸）');
    } else {
      const window = rateLimitWindow(env, webRateLimitWindowSeconds);
      const key = `web:${ip}:${window}`;
      try {
        // 先自增、再判断。以前是"读计数 → 走完整套上传和审核 → 成功后才自增"，
        // 中间的窗口里并发请求全都读到同一个旧值、全都放行（限 3 次能被穿到 10 次）。
        const used = await bot.store.bumpWebRateLimit(key, window);
        if (used > webRateLimitCount) {
          const minutes = Math.max(1, Math.ceil(webRateLimitWindowSeconds / 60));
          return jsonResponse({ ok: false, error: `提交太频繁了，请 ${minutes} 分钟后再试` }, 429);
        }
        if (Math.random() < 0.02) {
          // prune 的"现在"必须与限流桶同一只钟（env.WEB_RATE_LIMIT_CLOCK 注入），
          // 否则测试/特殊部署里桶会被真时钟判成过期随机清掉。
          const injectedClock = env?.WEB_RATE_LIMIT_CLOCK;
          const nowSecondsForPrune =
            typeof injectedClock === 'function' ? Math.floor(Number(injectedClock())) : nowSeconds();
          await bot.store.pruneWebRateLimits(86400, nowSecondsForPrune);
        }
      } catch (error) {
        // 老库还没跑迁移（没有 web_rate_limits 表）时降级为"不限流"，而不是把投稿整个打挂
        bot.logger?.warn?.(`网页限流表读不到（可能还没执行 npm run db:migrate）：${error?.message ?? error}`);
      }
    }
  }

  // 令牌一次性：同一个 token 只能换一次提交。以前它是纯无状态的，签名/有效期/答案
  // 都对就能在 30 分钟内无限重放——人机验证只挡住了"不会重发请求"的人。
  //
  // 登记点放在**校验通过之后**：放在前面的话，用户被"请填写正文"这类表单错误挡回来时
  // 令牌已经被烧掉，改完再提交会拿到 409 并把内容丢掉。校验失败本身没有重放价值。
  let nonceState = 'consumed';
  try {
    nonceState = await bot.store.consumeFormNonce(verification.nonce, verification.expiresAt);
  } catch (error) {
    bot.logger?.warn?.(`表单令牌登记失败（可能还没执行迁移）：${error?.message ?? error}`);
  }
  if (nonceState === 'reused') {
    return jsonResponse({ ok: false, error: '这次提交已经用过了，请刷新页面重新验证后提交' }, 409);
  }
  if (nonceState === 'unavailable') {
    bot.logger?.warn?.('表单令牌表缺失（web_form_nonces），本次无法防重放——请执行 npm run db:migrate');
  }

  try {
    const result = await bot.createWebSubmission({
      templateId,
      data,
      files: files.files,
      mediaStepId: files.stepId,
      nickname,
      ip,
      viewer: normalizeViewer(form.get('viewer')),
      email: normalizeEmail(form.get('email')),
    });
    if (Math.random() < 0.02) await bot.store.pruneFormNonces();
    // 全天计数只在成功收下之后加：被别的原因拒掉的请求不该消耗当天的配额
    if (webDailyLimit > 0) {
      try {
        const day = dailyBucket(env);
        await bot.store.bumpWebRateLimit(day.key, day.windowStart);
      } catch (error) {
        bot.logger?.warn?.(`全天计数写不进去：${error?.message ?? error}`);
      }
    }
    return jsonResponse({
      ok: true,
      id: result.id,
      status: result.status,
      link: result.link ?? null,
      viewer: normalizeViewer(form.get('viewer')),
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    bot.logger?.error?.('网页投稿失败：', message);
    await bot.notifyAdmins(`⚠️ 网页投稿处理失败：${escapeHtml(truncate(message, 200))}`);
    return jsonResponse({ ok: false, error: '提交失败，请稍后再试（管理员已收到通知）' }, 500);
  }
}
