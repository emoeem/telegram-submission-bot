/** 内联键盘构造。callback_data 统一用短前缀，控制在 64 字节内。 */

const KIND_LABELS = {
  photo: '🖼 图片',
  video: '🎬 视频',
  document: '📄 文件',
  audio: '🎵 音频',
  voice: '🎤 语音',
  poll: '📊 投票',
  location: '📍 位置',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? '📎 附件';
}

/** 回复按钮的文案：直接把评论内容带上去，避免"回复 1/2/3"对不上号。 */
export function commentReplyLabel(texts, comment) {
  const raw =
    String(comment?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim() || '（附件）';
  return texts('btnCommentReplyQuote', { text: raw.slice(0, 14) });
}

function keyboard(rows) {
  return { inline_keyboard: rows.filter((row) => row.length > 0) };
}

export function mainMenuKeyboard(
  texts,
  { hasSession = false, draftCount = 0, templates = [], mainGroupUrl = '', webPublicUrl = '' } = {},
) {
  const rows = [];
  // 网页投稿入口放在最前面：国内用户/不想装 Telegram 的人一眼就能看到；
  // 没配 WEB_PUBLIC_URL 时整行不出现，行为与以前完全一致。
  if (webPublicUrl) rows.push([{ text: texts('btnWebSubmit'), url: webPublicUrl }]);
  const multi = templates.length > 1;
  if (hasSession) {
    // 有进行中的投稿：只给"继续/新建"，新建时再选模板，避免一屏都是模板按钮
    rows.push([{ text: texts('btnResume'), callback_data: 'w:start' }]);
    rows.push([{ text: texts('btnNew'), callback_data: 'w:new' }]);
  } else if (multi) {
    for (const [id, template] of templates) {
      rows.push([{ text: template.name ?? id, callback_data: `w:start:${id}` }]);
    }
  } else {
    rows.push([{ text: texts('btnStart'), callback_data: 'w:start' }]);
  }
  if (draftCount > 0) {
    rows.push([{ text: `${texts('btnMyDrafts')}（${draftCount}）`, callback_data: 'w:drafts' }]);
  }
  // 「我的投稿」放菜单里：投稿发出去之后，用户没有任何按钮能看到自己投过什么，
  // 只能靠 /my 这个隐藏命令。放在这里等于把 /my 变成可点的入口。
  rows.push([{ text: texts('btnMyHistory'), callback_data: 'w:my' }]);
  rows.push([{ text: texts('btnHelp'), callback_data: 'w:help' }]);
  if (mainGroupUrl) rows.push([{ text: texts('btnMainGroup'), url: mainGroupUrl }]);
  return keyboard(rows);
}

/** 多模板时"新建投稿"先选类型。 */
export function templateChoiceKeyboard(texts, templates) {
  const rows = templates.map(([id, template]) => [{ text: template.name ?? id, callback_data: `w:start:${id}` }]);
  // 取消不是"丢掉"，而是回到刚被挂起的那一份
  rows.push([{ text: texts('btnNewCancel'), callback_data: 'w:newback' }]);
  return keyboard(rows);
}

/** 管理面板主菜单。 */
export function adminPanelKeyboard(texts, { pending = 0 } = {}) {
  return keyboard([
    [
      { text: texts('btnPanelStats'), callback_data: 'a:p:stats' },
      { text: `${texts('btnPanelPending')}（${pending}）`, callback_data: 'a:p:pending' },
    ],
    [
      { text: texts('btnPanelComments'), callback_data: 'a:p:comments' },
      { text: texts('btnPanelBans'), callback_data: 'a:p:bans' },
    ],
    [
      { text: texts('btnPanelSettings'), callback_data: 'a:p:settings' },
      { text: texts('btnPanelTargets'), callback_data: 'a:p:targets' },
    ],
    [
      { text: texts('btnPanelAudit'), callback_data: 'a:p:audit' },
      { text: texts('btnPanelAdmins'), callback_data: 'a:p:admins' },
    ],
    [
      { text: texts('btnPanelDiag'), callback_data: 'a:p:diag' },
      { text: texts('btnPanelHelp'), callback_data: 'a:p:help' },
    ],
  ]);
}

/** 只有一行按钮的简单键盘（面板里各处"返回"用）。 */
export function singleButtonKeyboard(texts, labelKey, callbackData) {
  return keyboard([[{ text: texts(labelKey), callback_data: callbackData }]]);
}

/** 待审核队列：每条一个预览按钮。 */
export function pendingQueueKeyboard(texts, items) {
  const rows = items.map((item) => [
    {
      text: texts('btnPendingPreview', {
        id: item.id,
        name: (item.fullName || item.username || String(item.userId) || '').slice(0, 12),
        body: (item.preview || '（无正文）').slice(0, 30),
      }),
      callback_data: `a:pv:${item.id}`,
    },
  ]);
  rows.push([{ text: texts('btnPanelHome'), callback_data: 'a:p:home' }]);
  return keyboard(rows);
}

/** 「评论」面板：最近有评论的投稿列表。 */
export function commentsPanelKeyboard(texts, items) {
  const rows = items.map((item) => [
    {
      text: texts('btnPanelCommentItem', { id: item.id, count: item.count }),
      callback_data: `a:cmt:${item.id}:0`,
    },
  ]);
  rows.push([{ text: texts('btnPanelHome'), callback_data: 'a:p:home' }]);
  return keyboard(rows);
}

/** 评论列表（给管理员）：每条一个"回复"按钮 + 分页。 */
export function commentAdminKeyboard(texts, submissionId, comments, { offset = 0, limit = 10, total = 0 } = {}) {
  const rows = comments.map((comment) => [
    {
      text: commentReplyLabel(texts, comment),
      callback_data: `a:crc:${submissionId}:${comment.chat_id}:${comment.message_id}`,
    },
  ]);
  const nav = [];
  if (offset + limit < total) {
    nav.push({ text: texts('btnCommentsOlder'), callback_data: `a:cmt:${submissionId}:${offset + limit}` });
  }
  if (offset > 0) {
    nav.push({
      text: texts('btnCommentsNewer'),
      callback_data: `a:cmt:${submissionId}:${Math.max(0, offset - limit)}`,
    });
  }
  if (nav.length > 0) rows.push(nav);
  return keyboard(rows);
}

/** 作者看的评论收件箱：每条一个匿名回复按钮 + 分页。 */
export function commentInboxKeyboard(texts, submissionId, comments, { offset = 0, limit = 5, total = 0 } = {}) {
  const rows = comments.map((comment) => [
    {
      text: commentReplyLabel(texts, comment),
      callback_data: `w:creply:${submissionId}:${comment.chat_id}:${comment.message_id}`,
    },
  ]);
  const nav = [];
  if (offset + limit < total) {
    nav.push({ text: texts('btnCommentsOlder'), callback_data: `w:clist:${submissionId}:${offset + limit}` });
  }
  if (offset > 0) {
    nav.push({
      text: texts('btnCommentsNewer'),
      callback_data: `w:clist:${submissionId}:${Math.max(0, offset - limit)}`,
    });
  }
  if (nav.length > 0) rows.push(nav);
  return keyboard(rows);
}

export function stepKeyboard(texts, step, { canBack = false, mediaCount = 0 } = {}) {
  const rows = [];
  if (step.type === 'choice') {
    step.options.forEach((option, index) => {
      rows.push([{ text: option, callback_data: `w:opt:${step.id}:${index}` }]);
    });
  }
  if (step.type === 'media') {
    rows.push([{ text: texts('btnAttachmentsDone'), callback_data: `w:done:${step.id}` }]);
    if (mediaCount > 0) {
      rows.push([{ text: texts('btnManageMedia'), callback_data: `w:media:${step.id}` }]);
    }
  }
  const controls = [];
  if (step.required === false) {
    controls.push({ text: texts('btnSkip'), callback_data: `w:skip:${step.id}` });
  }
  if (canBack) controls.push({ text: texts('btnBack'), callback_data: `w:back:${step.id}` });
  controls.push({ text: texts('btnCancel'), callback_data: 'w:cancel' });
  for (let i = 0; i < controls.length; i += 2) rows.push(controls.slice(i, i + 2));
  return keyboard(rows);
}

/**
 * 确认页键盘：确认 / 编辑内容 / 返回上一步 / 管理媒体 / 取消。
 * 「编辑内容」打开跳转菜单，「返回上一步」退回最后一个步骤（不清空任何数据）。
 */
export function previewKeyboard(texts, { hasMedia = false } = {}) {
  const rows = [
    [{ text: texts('btnConfirm'), callback_data: 'w:confirm' }],
    [
      { text: texts('btnEditContent'), callback_data: 'w:edit' },
      { text: texts('btnBackPreview'), callback_data: 'w:back' },
    ],
  ];
  if (hasMedia) rows.push([{ text: texts('btnManageMedia'), callback_data: 'w:media' }]);
  rows.push([{ text: texts('btnCancel'), callback_data: 'w:cancel' }]);
  return keyboard(rows);
}

/** 「编辑内容」：列出所有可见步骤，点哪项改哪项。 */
export function editMenuKeyboard(texts, steps) {
  const rows = steps.map((step) => [{ text: `${step.index}. ${step.label}`, callback_data: `w:goto:${step.id}` }]);
  rows.push([{ text: texts('btnBack'), callback_data: 'w:preview' }]);
  rows.push([{ text: texts('btnCancel'), callback_data: 'w:cancel' }]);
  return keyboard(rows);
}

/** 媒体管理：每个附件一行（上移/下移/删除），外加清空与返回。 */
export function mediaManagerKeyboard(texts, stepId, items) {
  const rows = items.map((item, index) => [
    { text: `${index + 1}. ${kindLabel(item.kind)}`, callback_data: 'w:noop' },
    { text: texts('btnMoveUp'), callback_data: `w:mm:${stepId}:${item.mediaId}:up` },
    { text: texts('btnMoveDown'), callback_data: `w:mm:${stepId}:${item.mediaId}:down` },
    { text: texts('btnDeleteItem'), callback_data: `w:mm:${stepId}:${item.mediaId}:del` },
  ]);
  if (items.length > 0) {
    rows.push([{ text: texts('btnReselectMedia'), callback_data: `w:mclear:${stepId}` }]);
  }
  rows.push([{ text: texts('btnMediaBack'), callback_data: `w:mback:${stepId}` }]);
  return keyboard(rows);
}

/** 发布失败后的原地重试键盘。 */
export function retryKeyboard(texts) {
  return keyboard([
    [{ text: texts('btnRetry'), callback_data: 'w:retry' }],
    [
      { text: texts('btnBackToEdit'), callback_data: 'w:edit' },
      { text: texts('btnCancel'), callback_data: 'w:cancel' },
    ],
  ]);
}

/**
 * 已发布/审核中的投稿按钮。
 * web=true 时投稿者没有 Telegram 账号：去掉「回复投稿者」「拉黑」这种只对 TG 用户有意义的按钮。
 */
export function adminKeyboard(texts, submissionId, { review = false, commentUrl = null, web = false } = {}) {
  // 公开评论区里，第一条永远是"人人可用"的评论入口（URL 按钮不受隐私模式影响）
  const commentRow = commentUrl ? [{ text: texts('btnCommentPublic'), url: commentUrl }] : [];
  const replyButton = { text: texts('btnReply'), callback_data: `a:reply:${submissionId}` };
  const banRow = web ? [] : [{ text: texts('btnBan'), callback_data: `a:ban:${submissionId}` }];
  if (review) {
    return keyboard([
      commentRow,
      [
        { text: texts('btnApprove'), callback_data: `a:ok:${submissionId}` },
        { text: texts('btnReject'), callback_data: `a:no:${submissionId}` },
      ],
      [{ text: texts('btnEditPublished'), callback_data: `a:edit:${submissionId}` }, ...(web ? [] : [replyButton])],
      banRow,
    ]);
  }
  return keyboard([
    commentRow,
    [...(web ? [] : [replyButton]), { text: texts('btnEditPublished'), callback_data: `a:edit:${submissionId}` }],
    [
      { text: texts('btnPin'), callback_data: `a:pin:${submissionId}` },
      { text: texts('btnRecall'), callback_data: `a:recall:${submissionId}` },
    ],
    banRow,
  ]);
}

/** 驳回理由：预设几条 + 自己写 + 不给理由。 */
export function rejectReasonsKeyboard(texts, submissionId, reasons) {
  const rows = reasons
    .slice(0, 6)
    .map((reason, index) => [{ text: reason, callback_data: `a:nr:${submissionId}:${index}` }]);
  rows.push([
    { text: texts('btnRejectCustom'), callback_data: `a:nc:${submissionId}` },
    { text: texts('btnRejectNoReason'), callback_data: `a:nn:${submissionId}` },
  ]);
  return keyboard(rows);
}

/** 撤回后还能一键重新发布。 */
export function republishKeyboard(texts, submissionId) {
  return keyboard([[{ text: texts('btnRepublish'), callback_data: `a:repub:${submissionId}` }]]);
}

/** 管理员点「编辑」后的分叉：改文案还是改媒体。 */
export function editActionKeyboard(texts, submissionId) {
  return keyboard([
    [
      { text: texts('btnEditText'), callback_data: `a:edittext:${submissionId}` },
      { text: texts('btnEditMedia'), callback_data: `a:editmedia:${submissionId}` },
    ],
  ]);
}

/** 收集新媒体时的键盘。 */
export function adminMediaKeyboard(texts, submissionId) {
  return keyboard([
    [{ text: texts('btnMediaDone'), callback_data: `a:emdone:${submissionId}` }],
    [
      { text: texts('btnMediaClear'), callback_data: `a:emclear:${submissionId}` },
      { text: texts('btnCancel'), callback_data: `a:emcancel:${submissionId}` },
    ],
  ]);
}

/** 我的草稿列表。 */
export function draftsKeyboard(texts, drafts) {
  const rows = [];
  for (const draft of drafts) {
    rows.push([
      { text: `${texts('btnDraftOpen')} #${draft.id}`, callback_data: `w:dopen:${draft.id}` },
      { text: texts('btnDraftDelete'), callback_data: `w:ddel:${draft.id}` },
    ]);
  }
  rows.push([{ text: texts('btnDraftBack'), callback_data: 'w:dback' }]);
  return keyboard(rows);
}

/** 收到评论时发给作者的键盘：每条评论一个"回复它"按钮。 */
export function commentUserKeyboard(texts, submissionId, comments = []) {
  const rows = comments.map((comment) => [
    {
      text: commentReplyLabel(texts, comment),
      callback_data: `w:creply:${submissionId}:${comment.chat_id}:${comment.message_id}`,
    },
  ]);
  rows.push([{ text: texts('btnAllComments'), callback_data: `w:clist:${submissionId}:0` }]);
  rows.push([{ text: texts('btnThreadContinue'), callback_data: `w:tell:${submissionId}` }]);
  return keyboard(rows);
}

/** 真人验证：给出几个表情，点对的那个。 */
export function captchaKeyboard(emojis) {
  const buttons = emojis.map((emoji, index) => ({ text: emoji, callback_data: `w:cap:${index}` }));
  return keyboard([buttons.slice(0, 2), buttons.slice(2, 4)].filter((row) => row.length > 0));
}

/** 群里的"投稿者补充"消息下面挂的操作。 */
export function threadAdminKeyboard(texts, submissionId) {
  return keyboard([
    [
      { text: texts('btnReply'), callback_data: `a:reply:${submissionId}` },
      { text: texts('btnBan'), callback_data: `a:ban:${submissionId}` },
    ],
  ]);
}

/** 发给投稿者的对话消息下面的按钮，方便他继续说话。 */
export function threadUserKeyboard(texts, submissionId) {
  return keyboard([[{ text: texts('btnThreadContinue'), callback_data: `w:tell:${submissionId}` }]]);
}

/** Owner 发布目标管理：每个目标独立开关，删除需要二次确认。 */
export function publishTargetsKeyboard(texts, targets) {
  const rows = [];
  for (const target of targets) {
    const state = Number(target.enabled) ? '✅' : '⏸️';
    const label = target.title || target.username || String(target.chat_id);
    rows.push([{ text: `${state} ${label}`, callback_data: `t:toggle:${target.id}` }]);
    rows.push([{ text: `🗑️ 删除「${label}」`, callback_data: `t:delete:${target.id}` }]);
  }
  if (targets.length === 0) rows.push([{ text: '📭 暂无授权目标', callback_data: 't:none' }]);
  return keyboard(rows);
}

export function publishTargetDeleteKeyboard(target) {
  const label = target?.title || target?.username || String(target?.chat_id ?? '目标');
  return keyboard([
    [
      { text: `确认删除「${label}」`, callback_data: `t:confirm_delete:${target.id}` },
      { text: '取消', callback_data: 't:cancel' },
    ],
  ]);
}
