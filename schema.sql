-- Cloudflare D1 表结构
-- 执行：npm run db:init          （线上库）
--       npm run db:init:local    （本地调试库）

-- 运行时可改的设置（管理员在群里用指令改，不需要重新部署）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);

-- 用户当前投稿进度
CREATE TABLE IF NOT EXISTS sessions (
  user_id           INTEGER PRIMARY KEY,
  template_id       TEXT    NOT NULL,
  step_id           TEXT,
  data              TEXT    NOT NULL DEFAULT '{}',
  prompt_chat_id    INTEGER,
  prompt_message_id INTEGER,
  updated_at        INTEGER NOT NULL
);

-- 投稿记录
CREATE TABLE IF NOT EXISTS submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  username          TEXT,
  full_name         TEXT,
  template_id       TEXT    NOT NULL,
  data              TEXT    NOT NULL,
  status            TEXT    NOT NULL,   -- pending / published / rejected / recalled / deleted
  content_hash      TEXT,               -- 内容指纹，用于重复投稿检测
  flags             TEXT,               -- 自动检查命中的项目（敏感词/链接），逗号分隔
  override_text     TEXT,               -- 管理员改写的整条文案（有则优先用它发布）
  publish_chat_id   INTEGER,
  publish_message_id INTEGER,
  media_chat_id     INTEGER,
  media_message_id  INTEGER,
  message_ids       TEXT,               -- 已发布的所有消息 ID（JSON 数组），撤回时一起删
  created_at        INTEGER NOT NULL,
  published_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_hash ON submissions (user_id, content_hash, created_at);

-- 匿名对话线程：记录"哪条消息属于哪条投稿"，实现管理员与投稿者的双向转发
CREATE TABLE IF NOT EXISTS thread_messages (
  chat_id       INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  submission_id INTEGER NOT NULL,
  direction     TEXT    NOT NULL,   -- to_user / to_admin
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

-- 黑名单
CREATE TABLE IF NOT EXISTS bans (
  user_id    INTEGER PRIMARY KEY,
  reason     TEXT,
  created_at INTEGER NOT NULL
);

-- 等待管理员输入的动作（回复投稿者 / 填写拒绝理由）
CREATE TABLE IF NOT EXISTS admin_actions (
  admin_id      INTEGER PRIMARY KEY,
  action        TEXT    NOT NULL,
  submission_id INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- 用户档案
CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,
  username   TEXT,
  full_name  TEXT,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- 去重：Telegram 重试投递时只处理一次
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id  INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 管理员角色：环境变量 ADMIN_IDS 是 bootstrap owner，数据库管理员可运行时管理
CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'admin', -- owner / admin / moderator
  added_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins (role);

-- 管理审计日志：记录谁在什么时候对什么对象做了什么
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);

-- 用户管理状态
CREATE TABLE IF NOT EXISTS user_controls (
  user_id INTEGER PRIMARY KEY,
  note TEXT,
  muted_until INTEGER,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_controls_muted ON user_controls (muted_until);


-- 经 Owner 授权的多发布目标；每个目标可独立启用，并可选择一个 Forum Topic。
CREATE TABLE IF NOT EXISTS publish_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL UNIQUE,
  chat_type TEXT NOT NULL,
  title TEXT,
  username TEXT,
  thread_id INTEGER,
  thread_title TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_targets_enabled ON publish_targets (enabled, id);

-- 一条投稿在多个目标中的实际消息，用于撤回、查找和后续管理。
CREATE TABLE IF NOT EXISTS submission_target_messages (
  submission_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  message_ids TEXT NOT NULL DEFAULT '[]',
  primary_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (submission_id, target_id),
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES publish_targets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stm_target ON submission_target_messages (target_id, submission_id);

-- 会话媒体：append-only，一行一个附件。
-- 相册里多张图是并发投递的多条 update，如果把它们塞进 sessions.data 的数组里
-- 做「读-改-写」，后到的写入会覆盖先到的，导致附件静默丢失。独立成行后天然安全。
CREATE TABLE IF NOT EXISTS session_media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  step_id    TEXT    NOT NULL,
  ordinal    INTEGER NOT NULL DEFAULT 0,
  kind       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  unique_id  TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, step_id, unique_id)
);
CREATE INDEX IF NOT EXISTS idx_session_media_user ON session_media (user_id, step_id, ordinal, id);

-- 投稿幂等守卫：防止连点「确认」、Telegram 超时重投、程序重启导致同一投稿发布多次。
-- guard_key 是唯一键，claim/lock 全靠它做原子 CAS。
CREATE TABLE IF NOT EXISTS submission_guards (
  guard_key     TEXT PRIMARY KEY,
  submission_id INTEGER,
  status        TEXT NOT NULL DEFAULT 'locked',  -- locked / submitted / published
  locked_until  INTEGER,                          -- 发布中租约；崩溃后可自动过期重试
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_guards_status ON submission_guards (status, updated_at);

-- 从旧版单目标 settings 自动迁移一个兼容目标；新逻辑随后完全以 publish_targets 为准。
-- 只在 publish_targets 完全为空时做一次 bootstrap：
-- 否则「删掉某个目标后又重跑 schema.sql」会把已经删掉的目标复活。
INSERT OR IGNORE INTO publish_targets
  (chat_id, chat_type, title, username, thread_id, thread_title, enabled, added_by, created_at, updated_at)
SELECT
  CAST(s.value AS INTEGER), 'supergroup', NULL, NULL,
  CASE WHEN ts.value IS NULL OR ts.value = '' THEN NULL ELSE CAST(ts.value AS INTEGER) END,
  NULL, 1,
  COALESCE((SELECT user_id FROM admins WHERE role = 'owner' ORDER BY created_at LIMIT 1), 0),
  CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
FROM settings s
LEFT JOIN settings ts ON ts.key = 'target_thread_id'
WHERE s.key = 'target_chat_id' AND s.value IS NOT NULL AND s.value != ''
  AND NOT EXISTS (SELECT 1 FROM publish_targets);

-- 多草稿：sessions 始终是"当前正在编辑的那一份"，drafts 存放被挂起的草稿。
-- 这样不用改 sessions 的主键，也就不需要 ALTER / 重建表。
CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  template_id TEXT    NOT NULL,
  step_id     TEXT,
  data        TEXT    NOT NULL DEFAULT '{}',
  title       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts (user_id, updated_at DESC);

-- 被挂起草稿的附件（结构与 session_media 一致，只是按 draft_id 归属）
CREATE TABLE IF NOT EXISTS draft_media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id   INTEGER NOT NULL,
  step_id    TEXT    NOT NULL,
  ordinal    INTEGER NOT NULL DEFAULT 0,
  kind       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  unique_id  TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (draft_id, step_id, unique_id),
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_draft_media_draft ON draft_media (draft_id, step_id, ordinal, id);

-- Telegram 官方评论区：记录"哪条评论属于哪条投稿"，用于通知作者和作者回复。
-- parent_* 与 kind 让"评论的评论"接得上（kind: user / author_reply / admin_reply）。
-- 老库要手动加这三列，见 migrations/2026-10-16-comment-replies-and-web.sql。
CREATE TABLE IF NOT EXISTS discussion_comments (
  chat_id            INTEGER NOT NULL,
  message_id         INTEGER NOT NULL,
  submission_id      INTEGER NOT NULL,
  thread_id          INTEGER,
  author_id          INTEGER,
  author_name        TEXT,
  text               TEXT,
  parent_message_id  INTEGER,
  parent_author_name TEXT,
  kind               TEXT NOT NULL DEFAULT 'user',
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_discussion_comments_sub ON discussion_comments (submission_id, created_at DESC);

-- 网页投稿者与管理员之间的匿名对话（网页投稿没有 Telegram，消息存在这里）
CREATE TABLE IF NOT EXISTS web_thread_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  direction     TEXT NOT NULL,            -- to_author / to_admin
  text          TEXT NOT NULL,
  seen_by_author INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_thread_sub ON web_thread_messages (submission_id, id);

-- 网页投稿的限流桶（按访客 IP 分桶，D1 原子累加）。老库同样见上面那个 migration 文件。
CREATE TABLE IF NOT EXISTS web_rate_limits (
  key          TEXT NOT NULL PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

-- 表单令牌的一次性登记：nonce 主键冲突 = 这个 token 已经被用过。
-- 没有这张表时，一个 token 在 30 分钟内可以无限重放（签名/有效期/答案都对）。
CREATE TABLE IF NOT EXISTS web_form_nonces (
  nonce      TEXT NOT NULL PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_form_nonces_exp ON web_form_nonces (expires_at);

-- 评论通知的聚合窗口：同一投稿同一作者只维护"当前这一条通知消息"，
-- 窗口内的新评论合并进去（编辑同一条消息），窗口外或攒满就另起一条。
CREATE TABLE IF NOT EXISTS comment_notifications (
  submission_id INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  chat_id       INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (submission_id, user_id)
);
