/** 通用小工具。 */

export function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 按 Telegram 的 offset/length 在原文上套 HTML 标签，同时保证转义，避免注入。 */
export function renderEntities(rawText, entities) {
  const text = String(rawText ?? '');
  const mapped = mapEntities(entities);
  if (!mapped.length) return escapeHtml(text);

  let out = '';
  let pos = 0;
  for (const ent of mapped) {
    const start = Math.max(pos, ent.start);
    const end = Math.min(text.length, ent.end);
    if (start >= end) continue;
    if (start > pos) out += escapeHtml(text.slice(pos, start));
    out += `${ent.open}${escapeHtml(text.slice(start, end))}${ent.close}`;
    pos = end;
  }
  out += escapeHtml(text.slice(pos));
  return out;
}

function mapEntities(entities) {
  if (!Array.isArray(entities)) return [];
  const spans = [];
  for (const ent of entities) {
    if (!ent || typeof ent.offset !== 'number' || typeof ent.length !== 'number') continue;
    if (ent.length <= 0 || ent.type === 'mention' || ent.type === 'bot_command') continue;
    const tag = entityTag(ent);
    if (!tag) continue;
    spans.push({ start: ent.offset, end: ent.offset + ent.length, open: tag.open, close: tag.close });
  }
  // 按起点排序；重叠的（例如加粗里套链接）直接丢弃后一个，最坏只是少一层样式
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const flat = [];
  let lastEnd = -1;
  for (const span of spans) {
    if (span.start < lastEnd) continue;
    flat.push(span);
    lastEnd = span.end;
  }
  return flat;
}

function entityTag(ent) {
  switch (ent.type) {
    case 'bold':
      return { open: '<b>', close: '</b>' };
    case 'italic':
      return { open: '<i>', close: '</i>' };
    case 'underline':
      return { open: '<u>', close: '</u>' };
    case 'strikethrough':
      return { open: '<s>', close: '</s>' };
    case 'spoiler':
      return { open: '<tg-spoiler>', close: '</tg-spoiler>' };
    case 'code':
      return { open: '<code>', close: '</code>' };
    case 'pre':
      return { open: '<pre>', close: '</pre>' };
    case 'blockquote':
      return { open: '<blockquote>', close: '</blockquote>' };
    case 'text_link':
      return ent.url ? { open: `<a href="${escapeHtml(ent.url)}">`, close: '</a>' } : null;
    case 'url':
      return null; // Telegram 客户端会自动识别链接
    default:
      return null;
  }
}

/** 截断文本，超出部分用省略号收尾。 */
export function truncate(text, maxLength, suffix = '…') {
  const value = String(text ?? '');
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - suffix.length)) + suffix;
}

/** 折叠连续空行，去掉行尾空格 —— 保证模板里空字段不会留下难看的大段空白。 */
export function tidy(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function safeFormat(template, params) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(params, key) ? String(params[key] ?? '') : match,
  );
}

export function fullName(from) {
  if (!from) return '';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || from.username || String(from.id ?? '');
}

export function linkForMessage(chatId, messageId, chatUsername) {
  if (!chatId || !messageId) return '';
  if (chatUsername) return `https://t.me/${chatUsername}/${messageId}`;
  const internal = String(chatId).replace(/^-100/, '').replace(/^-/, '');
  return `https://t.me/c/${internal}/${messageId}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 随机会话标识：给每次投稿发一个 nonce，用来做幂等键和按钮失效判断。 */
export function randomNonce(bytes = 6) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** 截断标记（长度算进预算，保证结果不超上限）。 */
const TRUNCATION_MARK = '\n<i>…（已截断）</i>';

/** 把 HTML 文本按字符预算裁到安全长度（Telegram 单条消息 4096 上限，留出余量）。
 *
 * 纯字符串切片会把 <b>/<a> 切成两半，Telegram 会以 "can't parse entities" 拒收，
 * 发布从此永远失败。所以截断后要做三件事：剥掉被切一半的标签、补全仍开着的
 * 标签栈、清掉被截断的 HTML 实体前缀。只预期本项目 render 输出的标签子集。 */
export function fitHtml(text, budget) {
  const value = String(text ?? '');
  if (value.length <= budget) return value;
  let cut = value.slice(0, Math.max(0, budget - TRUNCATION_MARK.length));
  // 被切断的实体（&am…）先清掉
  const trailingEntity = /&[a-zA-Z0-9#]{0,9}$/.exec(cut);
  if (trailingEntity) cut = cut.slice(0, trailingEntity.index);
  // 被切一半的起始标签（<b>abc<d…）直接丢弃
  const lastOpen = cut.lastIndexOf('<');
  const lastClose = cut.lastIndexOf('>');
  if (lastOpen > lastClose) cut = cut.slice(0, lastOpen);
  // 闭合仍开着的标签
  const stack = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  for (const match of cut.matchAll(tagRe)) {
    const name = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i] === name) {
          stack.length = i;
          break;
        }
      }
    } else if (!match[2]) {
      stack.push(name);
    }
  }
  const closings = stack
    .reverse()
    .map((name) => `</${name}>`)
    .join('');
  return `${cut}${closings}${TRUNCATION_MARK}`;
}

/** FNV-1a：给投稿内容算一个指纹，用于重复投稿检测（不需要加密强度）。 */
export function fingerprint(text) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 生成合法的话题标签：去掉空格和标点，只留下能当 hashtag 的字符。 */
export function toHashtag(text) {
  const cleaned = String(text ?? '')
    .replace(/[\s#]+/g, '')
    .replace(/[.,!?;:'"`~@$%^&*+=|\\/<>()[\]{}，。、！？；：（）【】「」『』·—…\-－_]+/g, '');
  return cleaned ? `#${cleaned}` : '';
}

export function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) {
    out.push(list.slice(index, index + size));
  }
  return out;
}

export function unique(list) {
  return [...new Set(list)];
}
