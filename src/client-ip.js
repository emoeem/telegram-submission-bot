/**
 * 解析网页访客的真实 IP。
 *
 * 直连（浏览器 → Worker）时只信 Cloudflare 注入的 cf-connecting-ip；
 * 经中继（国内可用的 Vercel/自建反代）时，Cloudflare 看到的是中继的出口地址，
 * 必须先用 x-relay-token 校验身份，再采信中继**覆写**过的转发头——否则任何人都能
 * 自己塞一个 x-forwarded-for 来刷穿限流桶。
 *
 * 踩过的坑（见 README「国内访问」）：Cloudflare 会把 x-real-ip 覆写成"与它相连的那一跳"
 * （也就是中继自己的出口），所以这里故意不读 x-real-ip。
 */

/** 转发头里取第一个非空值（Vercel 的 x-vercel-proxied-for 可能是逗号分隔的列表）。 */
function firstHop(raw) {
  const value = String(raw ?? '')
    .split(',')[0]
    .trim();
  return sanitizeIp(value);
}

/**
 * 转发头里取**最后一个**非空值。
 *
 * x-forwarded-for 是逐跳追加的：最左边那一段由客户端自己控制，最右边那一段才是
 * 离我们最近的那个代理写进去的。中继如果是 append 语义（很多反代默认如此），
 * 取首跳等于把伪造权交给访客：每个请求换一个假 IP 就能用一个新的限流桶。
 */
function lastHop(raw) {
  const parts = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return sanitizeIp(parts[parts.length - 1]);
}

function sanitizeIp(value) {
  if (!value) return null;
  // 只接受看起来像 IP 的东西，避免把任意字符串当 IP 写进限流键
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(value)) return null;
  return value.replace(/^\[|\]$/g, '');
}

/** 定长比较，避免用 === 比密钥（时序侧信道）。 */
export function safeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/**
 * 解析访客 IP；**解析不出来就返回 null**，不要编一个值出来。
 *
 * 这里的 null 是有意为之：以前未命中时会回落到 cf-connecting-ip，而经中继进来的
 * 请求那条头是**中继自己的出口 IP**，于是全站访客共用同一个限流桶（第 N 个访客
 * 就会被 429）。换成常量 'unknown' 是同一个错误换了个名字。拿不到真实 IP 时，
 * 调用方应该记录一次并跳过按 IP 限流，靠与 IP 无关的全天总闸兜底。
 */
export function resolveClientIp(request, { relaySecret = '', relayHeader = 'x-vercel-proxied-for' } = {}) {
  const headers = request.headers;
  const relayed = Boolean(relaySecret) && safeEqual(headers.get('x-relay-token'), relaySecret);
  if (relayed) {
    // 中继身份已验证：采信它写的转发头，但取**最后一跳**（离我们最近的那一段）。
    const candidates = [headers.get(relayHeader), headers.get('x-relay-client-ip'), headers.get('x-forwarded-for')];
    for (const candidate of candidates) {
      const ip = lastHop(candidate) ?? firstHop(candidate);
      if (ip) return ip;
    }
    // 中继验过了但一个 IP 头都没带：这时 cf-connecting-ip 是中继自己的出口地址，
    // 用它分桶会把所有访客算成同一个人。返回 null 让调用方去 warn。
    return null;
  }
  return firstHop(headers.get('cf-connecting-ip'));
}
