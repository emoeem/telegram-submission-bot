/**
 * 网页投稿的后台审核接口。
 *
 * 背景：网页投稿（`/submit`，不需要 Telegram 账号）原本只能在审核群里点按钮
 * 审 —— `deliverWebReview` 把卡片发到 ADMIN_CHAT_ID，管理员点「通过 / 拒绝」。
 * 那条链路没有问题，问题是它只能在手机上点：批量待审时在群消息里一条条翻，
 * 而且想看的上下文（邮箱、IP、命中词）挤在一条 4096 字的消息里。
 *
 * 这组接口把同一件事搬到桌面端，**不复用一份审核逻辑**：approve / reject 都调
 * `bot.approveSubmission` / `bot.rejectSubmission`，和群里按钮走同一套投稿级
 * 租约。两边各自实现的话，群里点通过、后台同时点通过，租约只能挡住同一侧的
 * 双击，跨端并发照样会发两遍。
 *
 * 鉴权是共享密钥 + fail-closed：没配 REVIEW_API_SECRET 时整组接口返回 503，
 * 而不是「没配就等于不用鉴权」。调用方是本项目的 admin Worker，它先用管理员
 * 会话校验一遍，再带上这个密钥转发过来。
 */

import { MAX_WEB_MEDIA_BYTES } from './handlers.js';

const PREFIX = '/api/admin/review';

/** 这个模块管哪些路径。 */
export function isAdminReviewPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 常量时间比较，避免按字节提前返回泄漏密钥前缀。
 *
 * Worker 里没有 node:crypto 的 timingSafeEqual，所以手写一份：长度不同直接
 * false（长度本身不是秘密），同长度则全程异或累加、不提前退出。
 */
function secretEquals(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  if (expected.length === 0 || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

/** 把 id 参数收紧成正整数；非法就返回 null。 */
function parseId(raw) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function clampLimit(raw, fallback = 20, max = 100) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 1), max);
}

const STATUSES = new Set(['pending', 'published', 'rejected', 'publishing', 'failed', 'recalled']);

/**
 * 处理一次后台审核请求。返回 null 表示"不是这条路径"，交回 index.js 继续路由。
 */
export async function handleAdminReviewRequest(request, { config, bot }) {
  const url = new URL(request.url);
  if (!isAdminReviewPath(url.pathname)) return null;

  // fail-closed：没配密钥就整体关闭，不提供"无鉴权的审核接口"。
  if (!config.reviewSecret) {
    return json(
      {
        ok: false,
        error: '后台审核接口未启用：请先执行 npx wrangler secret put REVIEW_API_SECRET，并在问卷平台配同一个值',
      },
      503,
    );
  }
  const provided = request.headers.get('x-review-secret') ?? '';
  if (!secretEquals(config.reviewSecret, provided)) {
    // 不回显具体原因：密钥错、缺头、空头在攻击者眼里不该有区别。
    return json({ ok: false, error: '未授权' }, 401);
  }
  if (!bot?.store) {
    return json({ ok: false, error: '缺少 D1 绑定（wrangler.toml 里的 [[d1_databases]]）' }, 500);
  }

  try {
    return await route(request, url, { bot });
  } catch (error) {
    bot.logger?.error?.('后台审核接口失败：', String(error?.message ?? error));
    return json({ ok: false, error: String(error?.message ?? error) }, 500);
  }
}

async function route(request, url, { bot }) {
  // 待审数量：给后台的角标用，前端不必为了一个数字拉全量列表。
  if (url.pathname === `${PREFIX}/count` && request.method === 'GET') {
    const pending = await bot.store.countWebSubmissionsForReview({ status: 'pending' });
    const total = await bot.store.countWebSubmissionsForReview();
    return json({ ok: true, pending, total });
  }

  if (url.pathname === `${PREFIX}/list` && request.method === 'GET') {
    const status = url.searchParams.get('status');
    const normalized = status && STATUSES.has(status) ? status : null;
    const limit = clampLimit(url.searchParams.get('limit'), 20, 100);
    const offset = Math.max(parseId(url.searchParams.get('offset')) ?? 0, 0);
    const [items, total] = await Promise.all([
      bot.store.listWebSubmissionsForReview({ status: normalized, limit, offset }),
      bot.store.countWebSubmissionsForReview({ status: normalized }),
    ]);
    // 列表只回摘要：正文可能有几千字，20 条一起塞进列表会让首屏慢一个数量级。
    return json({
      ok: true,
      total,
      limit,
      offset,
      items: items.map((item) => {
        const detail = bot.webReviewDetail(item);
        return {
          id: detail.id,
          status: detail.status,
          nickname: detail.nickname,
          fullName: detail.fullName,
          email: detail.email,
          flags: detail.flags,
          createdAt: detail.createdAt,
          publishedAt: detail.publishedAt,
          attachments: detail.attachments,
          preview: detail.text.slice(0, 160),
        };
      }),
    });
  }

  if (url.pathname === `${PREFIX}/detail` && request.method === 'GET') {
    const id = parseId(url.searchParams.get('id'));
    if (id === null) return json({ ok: false, error: '缺少投稿编号' }, 400);
    const submission = await bot.store.getSubmission(id);
    if (!submission) return json({ ok: false, error: '找不到这条投稿' }, 404);
    // 只允许看网页投稿：这组接口是给 `/submit` 那条链用的，Telegram 投稿有
    // 它自己的审核流，从这里顺手也能改状态会让两条链的权限边界糊掉。
    if (submission.data?.__source !== 'web') {
      return json({ ok: false, error: '这条不是网页投稿' }, 404);
    }
    return json({ ok: true, submission: bot.webReviewDetail(submission) });
  }

  /* 附件字节流。后台要在审核时看见图，但 Telegram 的 file_id 不能直接给浏览器
   * （那需要 BOT_TOKEN），所以由服务端换一次 getFile 再转发。
   *
   * 这条和其它接口一样吃同一把 x-review-secret，不额外开小口子 —— 多一套鉴权
   * 就多一处会写错的地方，而它能取的东西并不比 /detail 更多。 */
  if (url.pathname === `${PREFIX}/media` && request.method === 'GET') {
    const id = parseId(url.searchParams.get('submission') ?? url.searchParams.get('id'));
    if (id === null) return json({ ok: false, error: '缺少投稿编号' }, 400);
    const index = Number.parseInt(String(url.searchParams.get('index') ?? '0'), 10);
    if (!Number.isInteger(index) || index < 0) {
      return json({ ok: false, error: '附件序号不合法' }, 400);
    }
    const submission = await bot.store.getSubmission(id);
    if (!submission || submission.data?.__source !== 'web') {
      return json({ ok: false, error: '找不到这条网页投稿' }, 404);
    }

    const media = await bot.openWebSubmissionMedia(submission, index);
    if (!media) return json({ ok: false, error: '取不到这个附件' }, 404);
    if (media.tooLarge) {
      return json(
        {
          ok: false,
          error: `附件超过 ${Math.round(MAX_WEB_MEDIA_BYTES / 1024 / 1024)}MB，后台预览不了，请到审核群查看`,
        },
        413,
      );
    }

    const headers = new Headers();
    headers.set('content-type', media.contentType);
    if (media.length) headers.set('content-length', String(media.length));
    /* 管理端内容：允许本机短暂缓存（翻上一条再翻回来时不必再走一趟 Telegram），
     * 但绝不能进共享缓存。 */
    headers.set('cache-control', 'private, max-age=300');
    headers.set('x-content-type-options', 'nosniff');
    if (!media.inline) {
      headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(media.filename)}`);
    }
    return new Response(media.stream, { status: 200, headers });
  }

  if (url.pathname === `${PREFIX}/approve` && request.method === 'POST') {
    const body = await readJson(request);
    const id = parseId(body?.id);
    if (id === null) return json({ ok: false, error: '缺少投稿编号' }, 400);
    const target = await bot.store.getSubmission(id);
    if (!target || target.data?.__source !== 'web') {
      return json({ ok: false, error: '找不到这条网页投稿' }, 404);
    }
    const result = await bot.approveSubmission(id, { actorId: 0, actorLabel: 'web-admin' });
    if (!result.ok) {
      const message =
        result.reason === 'already_published'
          ? '这条投稿已经发布过了'
          : result.reason === 'in_flight'
            ? '这条投稿正在发布中，等它结束后再看'
            : result.reason === 'publish_failed'
              ? `发布失败：${result.error ?? '未知原因'}`
              : '这条投稿现在不能通过';
      return json({ ok: false, code: result.reason, error: message }, 409);
    }
    return json({ ok: true, id, link: result.link ?? null });
  }

  if (url.pathname === `${PREFIX}/reject` && request.method === 'POST') {
    const body = await readJson(request);
    const id = parseId(body?.id);
    if (id === null) return json({ ok: false, error: '缺少投稿编号' }, 400);
    const reason = String(body?.reason ?? '').trim();
    if (reason.length > 300) return json({ ok: false, error: '理由最多 300 字' }, 422);
    const target = await bot.store.getSubmission(id);
    if (!target || target.data?.__source !== 'web') {
      return json({ ok: false, error: '找不到这条网页投稿' }, 404);
    }
    const result = await bot.rejectSubmission(id, { actorId: 0, actorLabel: 'web-admin', reason });
    if (!result.ok) {
      const message =
        result.reason === 'already_rejected'
          ? '这条投稿已经驳回过了'
          : result.reason === 'already_published'
            ? '这条投稿已经发布到频道了，不能直接驳回；如需下架请先在群里撤回那条消息'
            : result.reason === 'in_flight'
              ? '这条投稿正在发布中，不能改成驳回'
              : '这条投稿现在不能驳回';
      return json({ ok: false, code: result.reason, error: message }, 409);
    }
    return json({ ok: true, id });
  }

  // 回复投稿者：网页投稿没有 Telegram 身份，走的是站内线程 + 邮件
  // （deliverToWebAuthor 两条都写）。和群里的「回复投稿者」是同一个出口。
  if (url.pathname === `${PREFIX}/reply` && request.method === 'POST') {
    const body = await readJson(request);
    const id = parseId(body?.id);
    if (id === null) return json({ ok: false, error: '缺少投稿编号' }, 400);
    const text = String(body?.text ?? '').trim();
    if (!text) return json({ ok: false, error: '内容不能为空' }, 422);
    if (text.length > 800) return json({ ok: false, error: '最多 800 字' }, 422);
    const target = await bot.store.getSubmission(id);
    if (!target || target.data?.__source !== 'web') {
      return json({ ok: false, error: '找不到这条网页投稿' }, 404);
    }
    await bot.deliverToWebAuthor(target, text);
    await bot.store.audit(0, 'submission.reply', 'submission', id, 'web-admin');
    return json({ ok: true, id });
  }

  // 这条路径属于本模块但没有对应动作：明确 404，别掉进后续路由变成白屏 HTML。
  return json({ ok: false, error: '未知的审核操作' }, 404);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
