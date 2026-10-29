-- 网页投稿者的匿名对话表（单独一个文件：和 ALTER 混在同一个文件里时，
-- 只要有一条 ALTER 因"列已存在"失败，D1 的整批导入会回滚，这张表就建不出来）。
-- 执行：npx wrangler d1 execute submission-bot-db --remote --file=./migrations/2026-10-17-web-thread-table.sql -y
CREATE TABLE IF NOT EXISTS web_thread_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  direction     TEXT NOT NULL,
  text          TEXT NOT NULL,
  seen_by_author INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_thread_sub ON web_thread_messages (submission_id, id);
