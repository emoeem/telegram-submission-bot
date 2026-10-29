/** Cloudflare Worker 入口：接收 Telegram Webhook。
 *
 * 路由：
 *   POST /webhook/<WEBHOOK_SECRET>  Telegram 回调（真正干活的地方）
 *   GET  /setup?secret=<SECRET>     设置 webhook + 命令菜单，返回自检结果
 *   GET  /submit                    网页投稿表单（给不用 Telegram 的人，见 README）
 *   GET  /api/submit/captcha        验证题（无状态 HMAC 令牌）
 *   POST /api/submit                提交网页投稿（multipart/form-data）
 *   GET  /api/admin/review/*        后台管理端的网页投稿审核（REVIEW_API_SECRET 鉴权）
 *   GET  /health                    健康检查
 */

import { checkConfig, loadConfig } from './config.js';
import { Bot } from './handlers.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { handleWebRequest } from './web.js';
import { handleAdminReviewRequest } from './admin-review.js';
import { safeEqual } from './client-ip.js';

// 每个 isolate 里按 D1 绑定缓存 Bot 实例（Telegram 客户端、群 username 都是懒加载的）
const botCache = new WeakMap();

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function getBot(config, env) {
  const key = JSON.stringify([
    config.token,
    config.apiBase,
    config.targetChatId,
    config.adminChatId,
    config.topicId,
    config.admins,
    config.options,
  ]);
  const cached = botCache.get(env.DB);
  if (cached && cached.key === key) return cached.bot;
  const bot = new Bot({
    config,
    store: new Store(env.DB),
    // TELEGRAM_FETCH 是测试用的注入点（假 Telegram 服务），生产环境为 undefined。
    telegram: new Telegram(config.token, { apiBase: config.apiBase, fetchImpl: env.TELEGRAM_FETCH }),
  });
  botCache.set(env.DB, { key, bot });
  return bot;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return json({ ok: true, service: 'telegram-submission-bot' });
    }
    if (url.pathname === '/health') {
      // 运维排障入口（README「排障速查」）：除了进程活着，还要 D1 答得上来。
      // D1 不可达时返回 503，监控/人一眼看出"Worker 活着但存储挂了"。
      try {
        if (!env.DB) return json({ ok: false, error: '缺少 D1 绑定' }, 503);
        await env.DB.prepare('SELECT 1').run();
        return json({ ok: true, service: 'telegram-submission-bot', db: 'ok' });
      } catch (error) {
        return json({ ok: false, db: 'unreachable', error: String(error?.message ?? error).slice(0, 120) }, 503);
      }
    }

    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      return json({ ok: false, error: `配置有问题：${error.message}` }, 500);
    }

    if (url.pathname === '/setup') return handleSetup(url, env, config);

    // 网页投稿（/submit、/api/submit*）：和 Telegram webhook 互不干扰，先走这里
    const webResponse = await handleWebRequest(request, { config, env, bot: getBot(config, env) });
    if (webResponse) return webResponse;

    // 后台管理端的网页投稿审核接口。鉴权是共享密钥（REVIEW_API_SECRET），
    // 和 webhook 的 secret 是两把不同的钥匙：一把给 Telegram，一把给 admin Worker。
    const reviewResponse = await handleAdminReviewRequest(request, { config, bot: getBot(config, env) });
    if (reviewResponse) return reviewResponse;

    const expectedPath = config.webhookSecret ? `/webhook/${config.webhookSecret}` : '/webhook';
    if (url.pathname !== expectedPath) {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    // 配置了 WEBHOOK_SECRET 之后，secret 头是第二道强制因子：
    // 缺失或不对一律 403（Telegram 配了 secret_token 后必带此头，合法流量不受影响）。
    // 之前"缺失即放行"的写法等于给伪造 update 留了门。
    const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (config.webhookSecret && (headerSecret === null || !safeEqual(headerSecret, config.webhookSecret))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!env.DB) {
      return json({ ok: false, error: '缺少 D1 绑定（wrangler.toml 里的 [[d1_databases]]）' }, 500);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (!update || typeof update.update_id !== 'number') {
      return new Response('Bad Request', { status: 400 });
    }

    // 先快速回 200，真正的处理丢进 waitUntil，避免 Telegram 等待超时后重投。
    const store = new Store(env.DB);
    let isNew;
    try {
      isNew = await store.markUpdateSeen(update.update_id);
    } catch (error) {
      return json(
        {
          ok: false,
          error: `数据库读写失败，先确认表结构已建好（npm run db:init）：${error.message}`,
        },
        500,
      );
    }
    if (!isNew) return json({ ok: true, duplicate: true });

    const bot = getBot(config, env);
    const shouldPrune = Math.random() < 0.02;
    ctx.waitUntil(
      (async () => {
        await bot.ensureTargetChat();
        try {
          await bot.handleUpdate(update);
          if (shouldPrune) {
            await store.pruneSeenUpdates();
            // 会话 TTL 的兜底清理：loadSession 只覆盖"用户自己回来"的情形
            await store.pruneExpiredSessions(config.options.sessionTtlSeconds);
          }
        } catch (error) {
          console.error('处理更新失败', update.update_id, error);
          await bot.notifyAdmins(`⚠️ 处理更新 ${update.update_id} 出错：${error?.message ?? error}`);
        }
      })(),
    );
    return json({ ok: true });
  },
};

async function handleSetup(url, env, config) {
  const secret = url.searchParams.get('secret') ?? '';
  // 与 webhook 头校验同一待遇：恒时比较（client-ip.js 的 safeEqual）。
  if (!config.webhookSecret || !safeEqual(secret, config.webhookSecret)) {
    return json({ ok: false, error: 'secret 不正确' }, 403);
  }

  const tg = new Telegram(config.token, { apiBase: config.apiBase, fetchImpl: env.TELEGRAM_FETCH });
  const webhookUrl = `${url.origin}/webhook/${config.webhookSecret}`;
  let effectiveConfig = config;
  try {
    const targets = await new Store(env.DB).listPublishTargets({ enabledOnly: true });
    if (targets.length > 0) {
      // 审核群不跟着目标群走：审核消息只能发到独立的 ADMIN_CHAT_ID。
      effectiveConfig = { ...config, targetChatId: targets[0].chat_id, reviewChatId: config.adminChatId ?? null };
    }
  } catch (error) {
    console.warn('读取发布目标失败：', error?.message ?? error);
  }
  const result = { ok: true, webhook_url: webhookUrl, problems: checkConfig(effectiveConfig) };

  try {
    await tg.setWebhook(webhookUrl, config.webhookSecret);
    await tg.setMyCommands();
    const me = await tg.getMe();
    const info = await tg.getWebhookInfo();
    result.bot = `@${me.username}`;
    result.webhook_info = info;
  } catch (error) {
    result.ok = false;
    result.error = error?.message ?? String(error);
  }
  return json(result, result.ok ? 200 : 500);
}
