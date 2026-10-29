/** 渲染与转义相关的单元测试（重点是别让用户内容破坏群消息格式）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TEMPLATE } from '../src/config.js';
import { createTexts } from '../src/texts.js';
import { attachmentsOf, composeSubmission, hashtagsFor } from '../src/render.js';
import { escapeHtml, renderEntities, tidy, truncate } from '../src/utils.js';
import { nextStep, previewLines, previousStep, visibleSteps } from '../src/wizard.js';

const config = {
  options: {
    tag: '#投稿',
    footer: '—— 投稿机器人',
    anonymousLabel: '匿名投稿',
    publishTemplate: '{tag} · {category}\n\n{title}\n{body}\n\n{meta}\n{footer}',
    maxTextLength: 2000,
    showStepHeader: true,
  },
  texts: createTexts(),
};

test('用户发来的 HTML 会被转义，不会注入群消息', () => {
  const text = composeSubmission(config, {
    data: {
      category: '文字分享',
      title: { plain: '<script>alert(1)</script>', html: escapeHtml('<script>alert(1)</script>') },
      body: { plain: '<b>假的</b>', html: escapeHtml('<b>假的</b>') },
      author: '匿名投稿',
    },
    template: DEFAULT_TEMPLATE,
    submissionId: 7,
    user: { fullName: '小明' },
  });
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(text, /&lt;b&gt;假的&lt;\/b&gt;/);
  assert.ok(!text.includes('<script>'));
});

test('正文里 Telegram 的粗体、链接、代码格式会被保留', () => {
  const raw = '前面 后面 点这里';
  const html = renderEntities(raw, [
    { type: 'bold', offset: 3, length: 2 },
    { type: 'text_link', offset: 6, length: 3, url: 'https://example.com/?a=1&b=2' },
  ]);
  assert.equal(html, '前面 <b>后面</b> <a href="https://example.com/?a=1&amp;b=2">点这里</a>');
});

test('重叠的实体不会把标签弄乱', () => {
  const html = renderEntities('abcdef', [
    { type: 'bold', offset: 0, length: 4 },
    { type: 'italic', offset: 1, length: 2 },
  ]);
  assert.equal(html, '<b>abcd</b>ef');
});

test('分支步骤（show_if）只在选中对应选项后出现', () => {
  assert.equal(
    visibleSteps(DEFAULT_TEMPLATE, { author: '匿名投稿' }).some((s) => s.id === 'signature'),
    false,
  );
  assert.equal(
    visibleSteps(DEFAULT_TEMPLATE, { author: '自定义署名' }).some((s) => s.id === 'signature'),
    true,
  );
  assert.equal(nextStep(DEFAULT_TEMPLATE, { author: '自定义署名' }, 'author').id, 'signature');
  assert.equal(nextStep(DEFAULT_TEMPLATE, { author: '匿名投稿' }, 'author').id, 'contact');
  assert.equal(nextStep(DEFAULT_TEMPLATE, {}, 'contact'), null);
  assert.equal(previousStep(DEFAULT_TEMPLATE, {}, 'category'), null);
});

test('确认页预览能把各项内容列出来', () => {
  const lines = previewLines(
    config,
    DEFAULT_TEMPLATE,
    {
      category: '图片分享',
      title: { plain: '标题党' },
      body: { plain: '正文' },
      photos: [
        { kind: 'photo', fileId: 'a' },
        { kind: 'photo', fileId: 'b' },
      ],
      author: '匿名投稿',
    },
    config.texts,
  );
  assert.match(lines.join('\n'), /分类<\/b>：图片分享/);
  assert.match(lines.join('\n'), /图片<\/b>：图片×2/);
  assert.match(lines.join('\n'), /署名方式<\/b>：匿名投稿/);
});

test('工具函数：截断、整理空行、找图片', () => {
  assert.equal(truncate('一二三四五', 3), '一二…');
  assert.equal(truncate('短', 5), '短');
  assert.equal(tidy('a\n\n\n\nb  \n'), 'a\n\nb');
  const attachments = [
    { kind: 'photo', fileId: 'a' },
    { kind: 'video', fileId: 'b' },
  ];
  assert.deepEqual(attachmentsOf({ photos: attachments }, DEFAULT_TEMPLATE), attachments);
  assert.deepEqual(attachmentsOf({}, DEFAULT_TEMPLATE), []);
});

test('标签：分类 + 内容类型自动生成多条 hashtag', () => {
  const configWithTags = {
    ...config,
    options: { ...config.options, tag: '#投稿', autoHashtags: true },
  };
  const tags = hashtagsFor(configWithTags, {
    data: { category: '图片分享' },
    template: DEFAULT_TEMPLATE,
    attachments: [
      { kind: 'photo', fileId: 'a' },
      { kind: 'video', fileId: 'b' },
    ],
  });
  assert.equal(tags, '#投稿 #图片分享 #图片 #视频');

  // 纯文字投稿
  const textOnly = hashtagsFor(configWithTags, { data: { category: '文字分享' }, template: DEFAULT_TEMPLATE });
  assert.equal(textOnly, '#投稿 #文字分享 #文字');
});

test('管理员改写过文案时，整条按改后的发', () => {
  const text = composeSubmission(config, {
    data: { category: '文字分享', body: { plain: '原始内容' } },
    template: DEFAULT_TEMPLATE,
    submissionId: 9,
    user: { fullName: '小明' },
    overrideText: '#投稿 #修改过的\n\n管理员改写的文案',
  });
  assert.equal(text, '#投稿 #修改过的\n\n管理员改写的文案');
});

test('fitHtml：截断不会把标签切成两半，闭合栈完整', async () => {
  const { fitHtml } = await import('../src/utils.js');
  const text = `${'<b>加粗开头'.repeat(30)}<a href="https://example.com/xxxx">链接`;
  const cut = fitHtml(text, 60);
  const opens = (cut.match(/<b>/g) ?? []).length;
  const closes = (cut.match(/<\/b>/g) ?? []).length;
  assert.equal(opens, closes, `b 标签必须配对：${cut}`);
  const aOpens = (cut.match(/<a /g) ?? []).length;
  const aCloses = (cut.match(/<\/a>/g) ?? []).length;
  assert.equal(aOpens, aCloses, `a 标签必须配对：${cut}`);
  assert.ok(!/<[a-zA-Z]+$/.test(cut.replace('<i>…（已截断）</i>', '')), `不能停在标签中间：${cut}`);
  assert.ok(cut.endsWith('…（已截断）</i>'), '保留截断标记');
  assert.equal(fitHtml('<b>hi</b>', 100), '<b>hi</b>');
});
