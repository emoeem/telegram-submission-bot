-- 增量迁移（2026-10-16）：评论回复 + 网页投稿
--
-- 已经部署过的库执行一次即可（新库不用，schema.sql 里已经带上）：
--   npx wrangler d1 execute submission-bot-db --remote --file=./migrations/2026-10-16-comment-replies-and-web.sql
-- 本地调试库把 --remote 换成 --local。
--
-- 重复执行第二条会报 "duplicate column name"，属于正常现象：
-- 只要第一条（CREATE TABLE IF NOT EXISTS）没报错，就已经迁移完成。

-- 1) 网页投稿的限流桶（新表，纯新增）
CREATE TABLE IF NOT EXISTS web_rate_limits (
  key          TEXT NOT NULL PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

-- 2) 评论的评论：记录"回复的那条评论是谁说的"
--    没执行也不会崩：机器人会自动退化成旧写法（评论照记，只是接不上回复关系），
--    群里发 /diag 也会提示还没迁移。
ALTER TABLE discussion_comments ADD COLUMN parent_message_id INTEGER;
ALTER TABLE discussion_comments ADD COLUMN parent_author_name TEXT;
ALTER TABLE discussion_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';

-- 3) 网页投稿者的匿名对话（新表，纯新增）
CREATE TABLE IF NOT EXISTS web_thread_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  direction     TEXT NOT NULL,            -- to_author / to_admin
  text          TEXT NOT NULL,
  seen_by_author INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_thread_sub ON web_thread_messages (submission_id, id);
