// UI text catalog for the Telegram submission bot.
// 所有文案集中在这里；用 TEXTS_JSON 环境变量按 key 覆盖。
export function createTexts(overrides = {}) {
  const texts = { ...defaults, ...overrides };
  return (key, vars = {}) => {
    let value = texts[key] ?? key;
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(replacement ?? ''));
    }
    return value;
  };
}

const defaults = {
  // ---------- 通用 ----------
  menu: '📮 投稿机器人',
  welcome: '你好！这里是匿名投稿机器人。请选择投稿类型，然后按提示完成投稿。',
  mainGroupIntro: '👥 投稿主群：请通过下方按钮进入。',
  btnMainGroup: '👥 进入投稿主群',
  btnWebSubmit: '🌐 网页投稿（不用装 Telegram）',
  webSubmitIntro: '🌐 也可以直接用网页投稿（不用装 Telegram，国内也能打开，地址可转发给朋友）：\n{url}',
  help:
    '📮 投稿说明\n\n点击开始投稿，按步骤填写内容。支持文字、图片、视频、文件、语音、位置和投票。\n\n' +
    '👉 图片/视频发完后点「就这些了」，然后你会看到完整预览，确认无误再发布。\n\n' +
    '👥 投稿主群：请通过下方按钮进入。',
  unknown: '请先点击开始投稿。',
  cancelled: '✅ 已取消这次投稿。',
  nothingToCancel: '当前没有进行中的投稿。',
  sessionResumed: '已恢复你上次未完成的投稿。',
  sessionExpired: '上次那份投稿放太久了，已经自动清掉，请重新开始。',

  // ---------- 步骤交互 ----------
  stepRequired: '这一步是必填项，请先完成。',
  stepTextExpected: '这一步需要用文字回答。',
  stepChoiceExpected: '这一步请点下面的按钮选择，不用发文字。',
  stepAttachmentExpected: '请发送图片、视频、文件、语音、位置或投票。',
  stepMediaLimit: '附件太多了，最多 {max_attachments} 个。',
  stepPhotosNone: '还没有收到附件，请继续发送，完成后点击按钮。',
  stepPhotosRecorded: '已收到 {count} 个附件。',
  stepRecordedText: '已记录。',
  stepRecordedChoice: '已选择：{value}',
  stepHeader: '第 {index}/{total} 步 · {template}',
  stepTooLong: '内容太长了，最多 {max_length} 个字符。',
  stepMediaReady: '附件已收到，完成后点击“就这些了”。',
  alreadyFirstStep: '已经是第一步了。',
  backHint: '已回到上一步。',
  expiredChoice: '这个操作已经过期，请从最新那条消息继续。',
  mediaSaveFailed: '刚才那个附件没能保存，请重新发一次。',

  // ---------- 按钮 ----------
  btnStart: '🚀 开始投稿',
  btnResume: '▶️ 继续投稿',
  btnNew: '🆕 新建投稿',
  btnMyDrafts: '📂 我的草稿',
  btnMyHistory: '📚 我的投稿',
  btnRestart: '🔄 重新开始',
  btnHelp: '❓ 使用说明',
  btnConfirm: '✅ 确认发布',
  btnEditContent: '✏️ 编辑内容',
  btnBackPreview: '⬅️ 返回上一步',
  btnManageMedia: '🗑 管理媒体',
  btnRetry: '🔁 重试发布',
  btnBackToEdit: '✏️ 返回修改',
  btnCancel: '❌ 取消',
  btnSkip: '跳过',
  btnBack: '⬅️ 上一步',
  btnAttachmentsDone: '✅ 就这些了',
  btnReselectMedia: '♻️ 重新选择全部',
  btnMediaBack: '✅ 返回',
  btnMoveUp: '⬆️',
  btnMoveDown: '⬇️',
  btnDeleteItem: '🗑',
  btnThreadContinue: '💬 接着说',
  btnRepublish: '♻️ 重新发布',

  // ---------- 预览 / 发布 ----------
  preview: '请确认投稿内容：\n\n{content}',
  previewDraftTitle: '—— 发布后的样子 ——',
  previewMediaCaption: '🔎 这些媒体会随投稿一起发布',
  previewMediaFailed: '（部分媒体预览失败，正式发布时会使用原始文件）',
  previewEmpty: '未填写',
  previewHint: '现在是确认页，请用下面的按钮操作：想改内容点「✏️ 编辑内容」，改完再点「✅ 确认发布」。',
  publishing: '⏳ 正在发布，请稍候…',
  publishingInProgress: '正在发布中，请稍候…',
  interrupted: '上次发布被中断',
  alreadySubmitted: '这条投稿已经提交过了，不用重复确认。',
  alreadySubmittedReview: '这条投稿已经送审了，请等管理员处理。',
  submittedPublished: '✅ 投稿已发布！\n\n📌 投稿链接：{link}\n\n👥 投稿主群：{main_group_url}',
  submittedNoLink: '✅ 投稿已发布！\n\n👥 投稿主群：{main_group_url}',
  submittedPending: '📨 投稿已收到，正在等待管理员审核。',
  submittedPartial: '✅ 投稿已发布（部分目标失败，已通知管理员）。',
  publishFailedRetry: '😢 发布失败：{error}\n\n已发布出去的部分不会重复发送，直接重试就会接着发剩下的。',
  adminPublishFailed: '⚠️ 投稿 #{submission_id} 发布失败：{error}',
  reviewNotConfigured:
    '⚙️ 机器人开着审核模式，但没有配置独立的审核群。\n为了避免未审核的草稿被公开发布，暂时不能收投稿。\n请管理员设置 ADMIN_CHAT_ID，或先执行 /review off。',
  reviewChatConflict:
    '⚙️ 审核群和发布群是同一个（或没配置），未审核的草稿会直接出现在公开群里。\n请管理员把 ADMIN_CHAT_ID 设成一个独立的群，或先执行 /review off。',
  previewSendFailed: '😢 消息没发出去，请发送 /start 重新开始这一步。',

  // ---------- 编辑菜单 ----------
  editMenuTitle: '✏️ 想改哪一项？',
  editMenuHint: '点一项进入修改，改完会自动回到确认页。',
  editMenuNone: '没有可以修改的项。',
  editBackHint: '改完这一步会自动回到确认页。',

  // ---------- 媒体管理 ----------
  mediaManagerTitle: '🎬 管理媒体（共 {count} 个）',
  mediaManagerHint: '点 ⬆️ ⬇️ 调整顺序，点 🗑 删除单个。也可以直接再发新的图片/视频。',
  mediaManagerEmpty: '还没有收到任何附件。',
  mediaDeleted: '已删除这个附件。',
  mediaMoved: '已调整顺序。',
  mediaMovedEdge: '已经在最前面或最后面了。',
  mediaCleared: '已清空，请重新发送图片/视频。',
  mediaNotFound: '这个附件已经不存在了，请重新打开管理面板。',

  // ---------- 投稿历史 ----------
  historyTitle: '📚 你最近的投稿',
  historyEmpty: '你还没有投过稿。',
  historyItem: '#{id} · {status} · {date}{link}',
  historyHint: '想补充说明，直接回复机器人发来的投稿回执就行。',
  statusPending: '待审核',
  statusPublishing: '发布中',
  statusPublished: '已发布',
  statusRejected: '未通过',
  statusRecalled: '已撤下',
  statusFailed: '发布失败',
  statusDeleted: '已删除',

  // ---------- 防滥用 ----------
  rateLimited: '投稿太频繁，请 {minutes} 分钟后再试。',
  blockedWord: '不允许的用词：「{word}」',
  blockedLink: '投稿不能带链接。',
  duplicateBlocked: '别重复投稿，相同内容暂时不能再次提交。',
  cooldownWait: '第一次投稿前先等 {seconds} 秒。',
  fixHint: '请修改后重新投稿。',
  banned: '投稿权限已被限制。',
  mutedUser: '投稿暂时被限制，请稍后再试。',
  captchaPrompt: '请点出下面的 {target}',
  captchaRemaining: '点错会换一道题（还有 {remaining} 次机会）。',
  captchaWrong: '点错了，已换一道题。',
  captchaTapHint: '这一步用下面的按钮选就行，直接发文字不算。',
  captchaFailed: '验证失败，本次投稿已取消。想投稿可以再点一次「开始投稿」。',

  // ---------- 匿名对话 ----------
  threadHint: '直接回复这条消息就能接着说。',
  threadButtonPrompt: '直接发你想说的话，我会匿名转达给管理员。',
  threadClosed: '这条投稿的对话已经关闭。',
  threadUserMessage: '作者补充（投稿 #{submission_id}）：\n{text}',
  adminReply: '管理员回复：\n{text}',
  adminReplyPrompt: '请直接发送要转达给投稿者的话。\n投稿 #{submission_id} · 用户 {user_id}',
  adminReplyDone: '✅ 已转达给投稿者。',
  adminReplyCancel: '已取消本次管理员操作。',
  adminReplyEmpty: '内容不能是空的，请重新发送，或发 /cancel 取消。',

  // ---------- 审核 ----------
  rejected: '😔 投稿没有通过审核。{reason}',
  approved: '✅ 已通过审核并发布。\n{link}',
  adminApprovedMsg: '已通过投稿 #{submission_id}。',
  adminAlreadyPublished: '这条已经发布过了。',
  adminBeingPublished: '这条正在发布中，请稍候。',
  adminRejectedMsg: '已拒绝投稿 #{submission_id}。',
  rejectReasonPrompt: '请选择驳回理由（投稿 #{submission_id}）：',
  rejectCustomPrompt: '把驳回理由发给我（发 /skip 就不给理由）。\n投稿 #{submission_id}',
  adminRejectDone: '已完成驳回投稿 #{submission_id}。',
  btnApprove: '✅ 通过',
  btnReject: '❌ 拒绝',
  btnRejectCustom: '✏️ 自己写一句',
  btnRejectNoReason: '🚫 不给理由',
  reviewOn: '✅ 审核模式已开启：投稿先发到独立审核群，点「通过」才公开。',
  reviewOff: '✅ 审核模式已关闭：投稿会直接发到群里。',
  reviewUsage: '用法：/review on 开启审核，/review off 关闭审核',

  // ---------- 管理员投稿操作 ----------
  btnReply: '💬 回复投稿者',
  btnEditPublished: '✏️ 编辑',
  btnPin: '📌 置顶',
  btnRecall: '🧹 撤下',
  btnBan: '🚫 拉黑',
  editDraftPrompt: '这是当前文案：\n\n{draft}\n\n直接发修改后的完整文案即可。',
  editDone: '✅ 已更新群里的投稿 #{submission_id}。',
  republishedDone: '♻️ 已重新发布投稿 #{submission_id}。',
  republishFailed: '重新发布失败：{error}',
  republishNotAllowed: '这条投稿当前状态不能重新发布。',
  noPublishedMessage: '这条投稿目前没有可管理的已发布消息。',
  recallDone: '已把投稿 #{submission_id} 从群里撤下。',
  pinDone: '已置顶投稿 #{submission_id}。',
  pinFailed: '置顶失败，请确认机器人有管理消息权限。',
  submissionNotFound: '找不到这条投稿。',
  webNoAuthorDm: '🌐 这条是网页投稿：投稿者没有 Telegram 账号，收不到私聊消息。',
  webReplyToInbox:
    '🌐 这条是网页投稿：你的回复会进入他的网页收件箱（他留了邮箱的话还会发邮件）。请直接发送要转达的话。',
  webReviewSource: '🌐 来自网页投稿（没有 Telegram 账号，收不到私聊通知）',

  // ---------- 管理员与权限 ----------
  adminOnly: '⛔ 这个指令只有管理员能用。',
  adminOnlyHint:
    '⛔ 这是管理员操作。\n\n💬 想评论这条投稿？点消息上的「💬 评论」按钮，或直接回复这条投稿，作者都会收到。',
  ownerOnly: '⛔ 只有所有者可以执行这个操作；你没有修改机器人配置的权限。',
  adminLevelDenied: '⛔ 你的管理员等级没有修改机器人配置的权限。',
  adminPanel:
    '🛠 管理员面板\n\n' +
    '/stats 统计 · /pending 待审核 · /user 用户详情 · /audit 审计\n' +
    '/ban 用户ID [原因] · /unban 用户ID · /banlist 黑名单\n' +
    '/mute 用户ID 分钟 · /unmute 用户ID · /note 用户ID 内容\n' +
    '/targets 发布目标管理（仅 Owner）\n' +
    '/bind 在目标群/话题中授权绑定 · /topic 把投稿发到当前话题（仅 Owner） · /review on|off 审核模式 · /settings 当前设置\n' +
    '/approve_all 批量通过\n\n' +
    '👥 所有者专用：/admins · /addadmin · /deladmin · /adminrole',
  adminStats: '📊 统计\n投稿：{total} · 已发布 {published} · 待审 {pending} · 拒绝 {rejected}',
  pendingTitle: '📥 待审核投稿',
  pendingEmpty: '没有待审核的投稿。',
  pendingHint: '下面是最近的待审核投稿。',
  adminsTitle: '👥 管理员列表',
  adminsEmpty: '暂无数据库管理员。',
  adminsUsage: '用法：/admins',
  adminAddUsage: '用法：/addadmin 用户ID [admin|moderator]',
  adminAdded: '已添加 {user_id} 为{role}。',
  adminRemoveUsage: '用法：/deladmin 用户ID',
  adminRemoved: '已移除管理员 {user_id}。',
  adminRoleUsage: '用法：/adminrole 用户ID admin|moderator',
  adminRoleChanged: '已将 {user_id} 调整为{role}。',
  adminNotFound: '找不到管理员 {user_id}。',
  lastOwnerProtected: '不能移除最后一个所有者。',
  adminEnvProtected: '来自 ADMIN_IDS 配置的所有者不能被删除。',
  adminBanUsage: '用法：/ban 用户ID [原因]',
  adminBanned: '已拉黑用户 {user_id}。',
  adminUnbanUsage: '用法：/unban 用户ID',
  adminUnbanned: '已解除拉黑 {user_id}。',
  adminBanlist: '🚫 黑名单\n{items}',
  adminBanlistEmpty: '黑名单为空。',
  userUsage: '用法：/user 用户ID',
  userNotFound: '找不到用户 {user_id}。',
  muteUsage: '用法：/mute 用户ID 分钟',
  mutedDone: '已将用户 {user_id} 静音 {minutes} 分钟。',
  unmuteUsage: '用法：/unmute 用户ID',
  unmutedDone: '已解除用户 {user_id} 的静音。',
  noteUsage: '用法：/note 用户ID 内容',
  noteDone: '已记录用户 {user_id} 的管理员备注。',
  auditTitle: '🧾 最近审计记录',
  auditEmpty: '暂无审计记录。',
  settingsText:
    '⚙️ 当前设置\n\n发布群：<code>{target}</code>\n来源：{source}\n发布话题：{topic}\n' +
    '审核模式：{review}\n审核群：<code>{review_chat}</code>\n限流：{rate}\n' +
    '最多附件：{max_attachments} 个 · 最多草稿：{max_drafts} 份\n标签：{tag}\n网页投稿：{web}',
  settingsWebOn: '已开启（<code>/submit</code>，{review}）{note}',
  settingsWebOff: '已关闭（WEB_ENABLED=0）',
  settingsWebNeedsReview: '投稿后需要管理员审核',
  settingsWebDirect: '投稿后直接发布',
  settingsWebNoReviewChat:
    '还没配审核群：审核卡片只能私聊发给"先私聊过机器人的管理员"，容易被漏看。建议设置 ADMIN_CHAT_ID 建个审核群。',
  settingsSourceDb: '在群里用 /bind 设定的',
  settingsSourceEnv: '来自 wrangler.toml 的兼容配置',
  settingsSourceNone: '还没设置（把机器人拉进目标群后由 Owner 执行 /bind）',
  settingsReviewNone: '未配置（审核模式下无法收稿）',
  bindWhereDefault: '群默认话题',
  bindPrivate: '发到群里才有用：把 /bind 发到你想用来发布投稿的群里，我就在那个群发帖。',
  bindFailed: '⚠️ 我在本群发消息失败了，请先把我设为群管理员，再发一次 /bind。',
  bindHint: '在本群发送 /bind，就能把这里授权为投稿发布目标（不用改配置、不用重新部署）。',
  bindWhereTopic: '本话题（{thread_id}）',
  bindForumHint:
    '\n\n💡 这是话题群：投稿现在发在 General。想发到指定话题，进那个话题再发一次 /topic（只有 Owner 能改）。',
  topicSet: '✅ 已把投稿发布位置设为<u>当前话题</u>（{thread_id}）。之后所有投稿都会发到这个话题。',
  topicCleared: '✅ 已把投稿发布位置改回本群主聊天区（General）。\n想再发到某个话题，进那个话题发一次 /topic 即可。',
  topicNotBound: '⚠️ 这个会话还不是发布目标：先在群里发一次 /bind 把本群设为发布群，再用 /topic 指定话题。',
  topicUsage:
    '📍 用法：进目标群里想发布的话题，发一次 /topic 就设成那个话题；在群主聊天区发 /topic（或 /topic off）则回到主聊天。',
  topicChanged: '📍 投稿发布话题已更新为 {where}。',
  topicClosedFellBack:
    '⚠️ 目标话题（{thread_id}）已被关闭，机器人没有「管理话题」权限，这条投稿先发到了主聊天区。\n' +
    '绑定没有被改动：打开那个话题、或给机器人「管理话题」权限后，会自动恢复发到话题里。',
  topicClosedRecovered: 'ℹ️ 目标话题（{thread_id}）之前是关闭状态，机器人已自动重新打开并把投稿发进去了。',
  topicClosedGeneral:
    '⚠️ 目标群的 General 话题被关闭，但机器人没有「管理话题」权限，投稿发不出去。\n' +
    '请给机器人开启「管理话题（Manage Topics）」权限，或先手动打开 General。',
  chatid: '本会话 ID：<code>{chat_id}</code>\n类型：{chat_type}',
  myid: '你的 ID：<code>{user_id}</code>',

  // ---------- 批量与审核辅助 ----------
  batchApproveNone: '现在没有待审核的投稿。',
  batchApproveDone: '已通过 {count} 条待审核投稿。',
  batchApprovePartial: '通过了 {count} 条，{failed} 条发布失败（详情见日志）。',
  reviewHistory: '👤 这位投稿者：累计 {total} 次投稿（通过 {published} / 拒绝 {rejected} / 待审 {pending}）',
  flaggedLine: '自动检查发现：{flags}',
  flagWord: '敏感词「{word}」',
  flagLink: '包含链接',

  // ---------- 多草稿 ----------
  draftsTitle: '📂 我的草稿',
  draftsEmpty: '你还没有挂起的草稿。',
  draftsHint: '点「继续编辑」接着写，点「删除」丢掉这份草稿。恢复草稿时当前没写完的会自动存起来。',
  draftItem: '#{id} · {title} · 停在{step} · {date}{media}',
  draftStepPreview: '确认页',
  draftSaved: '📂 当前这份草稿已经存进「我的草稿」，回来点「▶️ 继续投稿」或发 /drafts 就能接着写。',
  draftResumed: '已恢复这份草稿。',
  draftDeleted: '🗑 已删除这份草稿。',
  draftNotFound: '这份草稿已经不在了。',
  draftLimitDropped: '（草稿最多保留 {max} 份，最旧的一份已被自动清理）',
  btnDraftOpen: '▶️ 继续编辑',
  btnDraftDelete: '🗑 删除',
  btnDraftBack: '✅ 返回',

  // ---------- 管理员编辑媒体 ----------
  adminEditMenuTitle: '✏️ 编辑投稿 #{submission_id}',
  adminEditMenuHint: '你想改哪一部分？',
  btnEditText: '📝 改文案',
  btnEditMedia: '🎬 改媒体',
  adminMediaPrompt:
    '请把新的图片/视频/文件发给我（会**整体替换**原来的全部媒体）。\n发完点「✅ 就这些了」。\n\n投稿 #{submission_id}',
  adminMediaHeader: '🎬 正在收集新媒体（投稿 #{submission_id}）',
  adminMediaCountHint: '已收到 {count} 个附件。发完点「✅ 就这些了」。',
  adminMediaRemovedHint: '如果想让这条投稿变成纯文字，直接点「🧹 清空并去掉媒体」。',
  btnMediaDone: '✅ 就这些了',
  btnMediaClear: '🧹 清空并去掉媒体',
  adminMediaApplied: '✅ 已用新的媒体重新发布投稿 #{submission_id}。',
  adminMediaNoStep: '这个投稿用的模板里没有媒体步骤，改不了媒体。',
  adminMediaNotAllowed: '这条投稿正在发布中，请稍后再改。',
  adminMediaEmpty: '还没有收到任何新附件。',
  adminMediaKeepOld: '已取消，媒体保持原样。',
  adminMediaStale: '这次的媒体编辑已经过期了，请重新点「✏️ 编辑 → 🎬 改媒体」。',

  // ---------- 官方评论区 ----------
  commentNotify: '💬 你的投稿 #{submission_id} 收到 {count} 条新评论',
  commentNotifyItem: '• {name}：{text}',
  commentNotifyReplyItem: '• ↩️ {name} 回复 {target}：{text}',
  commentNotifyMore: '（本批共 {count} 条，上面只列了最新 {shown} 条）',
  commentAuthorLabel: '作者',
  commentAdminLabel: '管理员',
  btnCommentReply: '💬 回复这条评论',
  btnCommentReplyQuote: '↩️ {text}',
  btnCommentPublic: '💬 评论',
  commentReplyPrompt: '直接发你想说的话，我会匿名替你发到评论区。',
  commentReplySent: '✅ 已发到评论区。',
  commentReplyNone: '这条评论已经不在了，暂时没法回复。',
  authorCommentReply: '作者回复：\n{text}',
  authorCommentReplyNamed: '{name} 回复：\n{text}',
  adminCommentsTitle: '💬 投稿 #{submission_id} 的评论（最近 {count} 条）',
  adminCommentsEmpty: '这条投稿还没有收到评论。',
  adminCommentsUsage: '用法：/comments 投稿ID [偏移]',
  adminCommentsEnd: '没有更多评论了。',
  adminCommentsRange: '第 {from}-{to} 条 / 共 {total} 条',
  btnCommentsOlder: '⬅️ 更早',
  btnCommentsNewer: '➡️ 更新',
  adminCommentsItem: '• {name}：{text}',
  commentNoSubmission: '这条评论关联不到投稿，已忽略。',
  publicCommentPrompt:
    '💬 写下你的评论，我会替你发到这条投稿下面。\n' + '（评论是公开的，会署名「{name}」）\n\n投稿内容：{title}',
  publicComment: '💬 {name}：{text}',
  publicCommentDone: '✅ 评论已发出，作者会收到通知。',
  publicCommentGone: '这条投稿已经不在群里了，没法评论。',
  publicCommentTooLong: '评论太长了，请控制在 {max} 字以内。',

  // ---------- 管理面板 ----------
  panelTitle: '🛠 管理面板',
  panelHint: '点下面的按钮：',
  btnPanelStats: '📊 统计',
  btnPanelPending: '📥 待审',
  btnPanelComments: '💬 评论',
  btnPanelBans: '🚫 黑名单',
  btnPanelSettings: '⚙️ 设置',
  btnPanelTargets: '📮 发布目标',
  btnPanelAudit: '🧾 审计',
  btnPanelAdmins: '👥 管理员',
  btnPanelDiag: '🔍 评论区自检',
  btnPanelHelp: '❓ 全部指令',
  btnPanelHome: '⬅️ 返回面板',
  btnPanelBack: '⬅️ 返回队列',
  panelPendingTitle: '📥 待审核队列（共 {total} 条）',
  panelPendingHint: '点一条查看完整内容，再决定通过/拒绝。',
  panelPendingEmpty: '没有待审核的投稿。',
  panelPendingMore: '（只显示最新 {shown} 条，其余用 /pending 或直接看审核群）',
  btnPendingPreview: '#{id} · {name} · {body}',
  panelCommentsTitle: '💬 最近有评论的投稿',
  panelCommentsEmpty: '还没有收到任何评论。',
  panelCommentsHint: '点一条查看评论，并能直接回复。',
  btnPanelCommentItem: '#{id} · {count} 条评论',
  commentInboxTitle: '📋 投稿 #{submission_id} 的评论',
  commentInboxEmpty: '这条投稿还没有收到评论。',
  commentInboxDenied: '这条投稿不属于你。',
  commentInboxHint: '点下面带评论内容的按钮，就能匿名回复那一条。',
  btnAllComments: '📋 全部评论',
  commentReplyPromptQuote: '📝 你要回复 {name}：\n「{text}」\n\n直接发你想说的话，我会匿名替你发到评论区。',
  adminCommentReplyPrompt: '直接发要回复到评论区的话（会以「管理员回复」发出）。\n投稿 #{submission_id}',
  adminCommentReply: '管理员回复：\n{text}',
  adminCommentReplyDone: '✅ 已回复到评论区。',
  btnCommentReplyAdmin: '↩️ 回复',
  // ---------- 评论区自检 ----------
  diagTitle: '🔍 评论区自检',
  diagNoTarget: '还没有发布目标：先把机器人拉进群/频道，由 Owner 执行 /bind。',
  diagNoLinked: '   └ 没有关联讨论组：评论就直接出现在这个会话里',
  diagNeedsMessages: '     前提是机器人能收到群消息（见下方修复办法）',
  diagLinked: '   └ 关联讨论组：<code>{chat_id}</code>',
  diagBotAdmin: '     ✅ 机器人在讨论组里且是管理员 → 所有评论都能收到',
  diagBotMember: '     ⚠️ 机器人在讨论组里，但<u>不是管理员</u> → 频道帖的评论可能收不到（见下）',
  diagBotOut: '     ❌ 机器人不在这个讨论组里 → 评论根本收不到',
  diagBotUnknown: '     ⚠️ 无法确认机器人在讨论组里的身份',
  diagChatError: '   ⚠️ 读不到会话信息：{error}',
  diagGroupNoLinked:
    '   └ 普通群：评论就是"回复机器人发的那条投稿"。Telegram 本来就会把这类回复推给机器人，' +
    '通常不用改任何设置；如果收不到，点下面的「🧪 测一测」确认。',
  diagChannelNoDiscussion:
    '   └ ❗️ 这是<u>频道</u>、而且没有关联讨论组：普通用户在频道里根本无法发言，' +
    '所以<u>现在没有任何人能评论</u>（跟机器人设置无关）。\n' +
    '     修复：频道 → 管理 → Discussions（讨论）→ 关联一个群；\n' +
    '     再把机器人设为那个群的<u>管理员</u>（否则它的评论推送收不到）。',
  diagChannelLinkedHint:
    '     （频道帖的评论回复的是 Telegram 转发的副本，不是机器人发的，' +
    '所以要么让机器人当讨论组管理员，要么在 BotFather 里关掉隐私模式）',
  diagWatchArmed:
    '🧪 已就绪（5 分钟内有效）：请用<u>另一个非管理员账号</u>在这个群里回复任意一条消息' +
    '（最好直接回复一条已发布的投稿）。收到了我会私聊告诉你。',
  diagWatchOk:
    '✅ 测试通过：我收到了这个群（<code>{chat_id}</code>）里来自 {name} 的消息，\n' +
    '说明消息推送是通的——评论功能应该能正常工作。',
  diagWatchExpired: '⌛️ 上一次评论区测试已经超时了，需要的话再点一次「🧪 测一测」。',
  btnDiagWatch: '🧪 测一测：我能收到这个群的消息吗',
  diagFix:
    '说明：只有在"频道 + 关联讨论组"这条链路上，评论才会回复到 Telegram 转发的副本，' +
    '这时才需要机器人当讨论组管理员，或在 @BotFather 里执行 /setprivacy → Disable；\n' +
    '普通群里"回复机器人的投稿"默认就能收到，不需要改任何设置。',
  diagNeedsMigration:
    '🗄 数据库还缺「评论回复」字段：现在只能回复投稿本身，<u>回复某条评论</u>接不上。\n' +
    '管理员执行一次 migration（见 README「让评论支持回复」）即可开启。',
  // ---------- 多模板 ----------
  chooseNewTemplate: '🆕 想写哪种投稿？',
  btnNewCancel: '↩️ 回到刚才那份',
  batchApproveRemaining: '还有 {n} 条待审核，再执行一次 /approve_all 即可。',
};
