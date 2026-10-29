/** 投稿流程状态机（纯函数，不碰网络，方便单测）。 */

import { escapeHtml, truncate } from './utils.js';

/** 按 show_if 条件过滤出当前该走的步骤。 */
export function visibleSteps(template, data) {
  return template.steps.filter((step) => {
    const cond = step.show_if;
    if (!cond) return true;
    return String(data?.[cond.step] ?? '') === String(cond.equals ?? '');
  });
}

export function findStep(template, stepId) {
  return template.steps.find((step) => step.id === stepId) ?? null;
}

export function firstStep(template, data) {
  return visibleSteps(template, data)[0] ?? null;
}

/** 下一步；返回 null 表示进入确认页。 */
export function nextStep(template, data, currentStepId) {
  const steps = visibleSteps(template, data);
  const index = steps.findIndex((step) => step.id === currentStepId);
  if (index < 0) return steps[0] ?? null;
  return steps[index + 1] ?? null;
}

/** 上一步；返回 null 表示已经在第一步。 */
export function previousStep(template, data, currentStepId) {
  const steps = visibleSteps(template, data);
  const index = steps.findIndex((step) => step.id === currentStepId);
  if (index <= 0) return null;
  return steps[index - 1];
}

export function stepTitle(step) {
  return step.label ?? step.prompt;
}

/** 取出步骤值的可读文本（文本步骤存的是 {plain, html}）。 */
export function textOf(value) {
  if (Array.isArray(value)) return value.join('、');
  if (value && typeof value === 'object') return String(value.plain ?? '');
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 校验用户输入，返回错误文案或 null。 */
export function validateAnswer(step, value, config, texts) {
  const text = String(value ?? '').trim();
  if (!text) {
    return step.required === false ? null : texts('stepRequired');
  }
  const limit = Math.min(step.max_length ?? config.options.maxTextLength, config.options.maxTextLength);
  if (text.length > limit) return texts('stepTooLong', { max_length: limit });
  return null;
}

/** 步骤提示语：可选的步骤标题头 + 提问文案。 */
export function promptText(config, template, step, data, texts) {
  const parts = [];
  if (config.options.showStepHeader) {
    const steps = visibleSteps(template, data);
    const index = steps.findIndex((item) => item.id === step.id) + 1;
    parts.push(texts('stepHeader', { index, total: steps.length, template: template.name ?? '投稿' }));
  }
  parts.push(escapeHtml(step.prompt));
  if (step.type === 'media' && !step.required) {
    parts.push(`<i>${escapeHtml(texts('stepMediaReady'))}</i>`);
  }
  return parts.join('\n\n');
}

/** 确认页的逐项预览。 */
export function previewLines(config, template, data, texts) {
  const lines = [];
  for (const step of visibleSteps(template, data)) {
    const value = data?.[step.id];
    let display;
    if (step.type === 'media') {
      const list = Array.isArray(value) ? value : [];
      if (list.length === 0) {
        display = texts('previewEmpty');
      } else {
        const labels = {
          photo: '图片',
          video: '视频',
          document: '文件',
          audio: '音频',
          voice: '语音',
          poll: '投票',
          location: '位置',
        };
        const counts = new Map();
        for (const item of list) {
          const label = labels[item?.kind] ?? '附件';
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        display = [...counts].map(([label, count]) => `${label}×${count}`).join('、');
      }
    } else if (Array.isArray(value)) {
      display = value.join('、') || texts('previewEmpty');
    } else {
      display = textOf(value).trim() || texts('previewEmpty');
    }
    lines.push(`<b>${escapeHtml(stepTitle(step))}</b>：${escapeHtml(truncate(display, 300))}`);
  }
  return lines;
}
