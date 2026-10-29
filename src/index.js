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

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'telegram-submission-bot' });
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
    const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (headerSecret && config.webhookSecret && headerSecret !== config.webhookSecret) {
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
          if (shouldPrune) await store.pruneSeenUpdates();
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
  if (!config.webhookSecret || secret !== config.webhookSecret) {
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
