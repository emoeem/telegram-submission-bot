/** 把投稿内容渲染成发到群里的 HTML 文本。 */

import { escapeHtml, safeFormat, tidy, toHashtag, unique } from './utils.js';
import { textOf } from './wizard.js';

/** 附件统一用 {kind, fileId, uniqueId, ...} 表示，kind 见下方。 */
export function attachmentsOf(data, template) {
  const step = template?.steps?.find((item) => item.type === 'media');
  const value = step ? data?.[step.id] : undefined;
  return Array.isArray(value) ? value : [];
}

export function attachmentKinds(attachments) {
  return unique(attachments.map((item) => item.kind));
}

/** 按分类和内容类型自动拼标签：#投稿 #图片分享 #图片 */
export function hashtagsFor(config, { data, template, attachments = [] }) {
  const tags = [config.options.tag];
  if (config.options.autoHashtags !== false) {
    const categoryStep = template?.steps?.find((step) => step.type === 'choice');
    const category = categoryStep ? String(data?.[categoryStep.id] ?? '') : '';
    tags.push(toHashtag(category));

    const kinds = attachmentKinds(attachments);
    const kindTags = [];
    if (kinds.includes('photo')) kindTags.push('#图片');
    if (kinds.includes('video')) kindTags.push('#视频');
    if (kinds.includes('document')) kindTags.push('#文件');
    if (kinds.includes('voice') || kinds.includes('audio')) kindTags.push('#语音');
    if (kinds.includes('poll')) kindTags.push('#投票');
    if (kinds.includes('location')) kindTags.push('#位置');
    if (kindTags.length === 0) kindTags.push('#文字');
    tags.push(...kindTags);
  }
  return unique(tags.filter(Boolean)).join(' ');
}

/**
 * 投稿者想让别人看到的署名（匿名返回空串）。
 * 发布文案和"作者回复评论"共用这一套判断，避免两处规则不一致。
 */
export function authorDisplayName(config, data, user) {
  const options = config.options;
  const authorChoice = String(data?.author ?? '');
  if (!authorChoice || authorChoice === options.anonymousLabel) return '';
  if (authorChoice === '显示我的昵称') return user?.fullName || user?.username || '';
  return textOf(data.signature) || authorChoice;
}

/**
 * 组装最终发布的文本。
 * publish_template 可用占位符：{tag} {tags} {category} {title} {body} {meta} {from} {footer} {id}
 * 管理员改写过文案时，整条用它（override 优先）。
 */
export function composeSubmission(
  config,
  { data, template, submissionId, idText, user, attachments = [], overrideText },
) {
  if (overrideText) return tidy(overrideText);

  const { options } = config;
  const categoryStep = template.steps.find((step) => step.type === 'choice');
  const category = categoryStep ? String(data[categoryStep.id] ?? '') : '';
  const title = textOf(data.title).trim();
  const body = data.body?.html ?? escapeHtml(textOf(data.body));

  const authorChoice = String(data.author ?? '');
  const displayName = authorDisplayName(config, data, user);
  let from = '';
  if (displayName) {
    from = `投稿者：${escapeHtml(displayName)}`;
  } else if (authorChoice) {
    from = '投稿者：匿名';
  }

  const contact = textOf(data.contact).trim();
  const meta = [contact ? `联系方式：${escapeHtml(contact)}` : '', from].filter(Boolean).join('\n');
  const tags = hashtagsFor(config, { data, template, attachments });

  const text = tidy(
    safeFormat(options.publishTemplate, {
      tag: tags,
      tags,
      category: escapeHtml(category),
      title: title ? `<b>${escapeHtml(title)}</b>` : '',
      body,
      meta,
      from,
      footer: options.footer,
      id: idText ?? `#${submissionId}`,
    }),
  );
  return text;
}

/** 群里第一条消息的短标题（相册 caption 有 1024 字上限）。 */
export function mediaCaption(config, { data, template, attachments = [] }) {
  const categoryStep = template.steps.find((step) => step.type === 'choice');
  const category = categoryStep ? String(data[categoryStep.id] ?? '') : '';
  const title = textOf(data.title).trim();
  return tidy(
    safeFormat('{tags}\n{title}', {
      tags: hashtagsFor(config, { data, template, attachments }),
      category: escapeHtml(category),
      title: title ? `<b>${escapeHtml(title)}</b>` : '',
    }),
  );
}

/** 审核消息里给管理员看的提示：自动检查结果 + 投稿者历史。 */
export function reviewNotes(texts, { flags = [], stats } = {}) {
  const lines = [];
  if (flags.length > 0) {
    const labels = flags.map((flag) =>
      flag.startsWith('word:') ? texts('flagWord', { word: flag.slice(5) }) : texts('flagLink'),
    );
    lines.push(texts('flaggedLine', { flags: labels.join('、') }));
  }
  if (stats) {
    lines.push(
      texts('reviewHistory', {
        total: stats.total,
        published: stats.published,
        rejected: stats.rejected,
        pending: stats.pending,
      }),
    );
  }
  return lines;
}
