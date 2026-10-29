-- 表单令牌的一次性登记（2026-10-29）
--
-- 背景：/api/submit/captcha 发的是无状态 HMAC 令牌（expires.nonce.signature），
-- 服务端只验签名、有效期和答案，**不记录这个令牌有没有用过**。于是同一个
-- token + 同一个答案在 30 分钟内可以无限重放，所谓人机验证只挡住了不会重发
-- 请求的人。这张表用 nonce 主键冲突做一次性登记。
--
-- 老库没这张表时服务端退化放行并打 warn（不因缺表把正常投稿全拦掉）。
CREATE TABLE IF NOT EXISTS web_form_nonces (
  nonce      TEXT NOT NULL PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_form_nonces_exp ON web_form_nonces (expires_at);
