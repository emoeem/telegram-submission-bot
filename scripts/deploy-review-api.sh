#!/usr/bin/env bash
# ⚠️ 2026-10-29 起本脚本已停用：生产已迁到当前新账号，公开审核后台由问卷平台承接。
#    下面的账号/地址是旧账号的，保留仅作历史参考；不要直接执行。
#
# 用旧账号部署 submission-bot 并配 REVIEW_API_SECRET。
# 如需重新启用，先把 TARGET_ACCOUNT_ID / BOT_URL 改成当前部署，再 export REVIEW_API_SECRET。
#
# 两种模式：
#   1) Token 模式（推荐，不受浏览器会话影响）
#        CF_TOKEN=xxx bash scripts/deploy-review-api.sh
#   2) 登录模式（会临时接管本机 wrangler 登录，结束后原样还原）
#        bash scripts/deploy-review-api.sh
#
# 为什么要有 Token 模式：wrangler login 走 OAuth，授权页会直接复用浏览器里
# 已有的 Cloudflare 会话。如果浏览器登录的是另一个账号，点 Authorize 拿到的是
# 那个账号的 token —— wrangler 会打印 "Successfully logged in."，但身份是错的。
# 这是 OAuth 的正常行为，不是 wrangler 的 bug。API Token 不经过浏览器会话，
# 所以只要 token 建对了账号，就不可能串。
set -euo pipefail

TARGET_ACCOUNT_ID="<OLD_ACCOUNT_ID>"
TARGET_EMAIL_HINT="<old-account-email>"
SECRET_VALUE="${REVIEW_API_SECRET:?请先 export REVIEW_API_SECRET}"
CFG="$HOME/.config/.wrangler/config/default.toml"
BOT_URL="https://submission-bot.<old-subdomain>.workers.dev"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RESTORE_NEEDED=0
restore() {
  if [ "$RESTORE_NEEDED" = "1" ] && [ -f "$BAK" ]; then
    cp -p "$BAK" "$CFG"
    rm -f "$BAK"
    echo "↩️  已还原 wrangler 登录配置（原账号恢复）"
  fi
}
trap restore EXIT
cd "$PROJECT_DIR"

# ─────────────────────────────────────────────────────────────
# Token 模式
# ─────────────────────────────────────────────────────────────
if [ -n "${CF_TOKEN:-}" ]; then
  echo "🔑 使用 API Token 模式（不触碰本机 wrangler 登录）"

  # 直连 CF API 验证这张 token 对目标账号有没有 Workers 权限。
  # 这比 whoami 准：whoami 说的是「token 属于谁」，这里问的是「能不能操作这个账号」。
  # 用 HTTP 码判定，不 grep 响应体：CF 的 JSON 里 "success" 在末尾，
  # 一旦被 head -c 截断就会把成功误判成失败。
  PROBE_FILE="$(mktemp)"
  probe_code=$(curl -s -o "$PROBE_FILE" -w '%{http_code}' -m 30 \
    -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$TARGET_ACCOUNT_ID/workers/scripts?per_page=1")
  if [ "$probe_code" != "200" ]; then
    echo "✗ Token 对账号 $TARGET_ACCOUNT_ID 无效或无 Workers 权限（HTTP $probe_code）：" >&2
    head -c 400 "$PROBE_FILE" >&2; echo >&2; rm -f "$PROBE_FILE"
    echo "  Token 需要的权限：Account → Workers Scripts : Edit、D1 : Edit" >&2
    exit 1
  fi
  rm -f "$PROBE_FILE"
  echo "✓ Token 可操作目标账号"

  # 让 wrangler 走 token 而不是 OAuth：它的优先级是
  # CLOUDFLARE_API_TOKEN > 配置文件里的 OAuth
  export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
  export CLOUDFLARE_ACCOUNT_ID="$TARGET_ACCOUNT_ID"

# ─────────────────────────────────────────────────────────────
# 登录模式
# ─────────────────────────────────────────────────────────────
else
  if [ ! -f "$CFG" ]; then
    echo "✗ 未找到 $CFG —— 本机从未 wrangler login 过" >&2
    echo "  改用 Token 模式：CF_TOKEN=xxx bash $0" >&2
    exit 1
  fi
  BAK="$CFG.bak.$(date +%s)"
  cp -p "$CFG" "$BAK"
  RESTORE_NEEDED=1
  echo "🔐 已备份 wrangler 登录配置 → $BAK"

  current_email() {
    npx --yes wrangler whoami 2>/dev/null \
      | grep -oE 'associated with the email [^ .]+' | awk '{print $NF}' | head -1
  }

  EMAIL="$(current_email || true)"
  echo "当前登录邮箱: ${EMAIL:-未知}"

  if [ "$EMAIL" != "$TARGET_EMAIL_HINT" ]; then
    cat <<'TIP'

▶ 需要登录 <old-account-email>

  ⚠️  授权页会复用浏览器里现有的 Cloudflare 登录态。如果浏览器当前登录的是
     另一个账号，你点 Authorize 拿到的就是那个账号 —— 表现正是「提示 Successfully
     logged in，但 whoami 还是旧邮箱」。

     两种做法，任选：
       a) 先在浏览器打开 https://dash.cloudflare.com/logout 退出，再回到这里
       b) 打开一个无痕窗口，在里面登录 <old-account-email>，然后把下方 URL 粘进无痕窗口

TIP
    npx --yes wrangler login
    EMAIL="$(current_email || true)"
  fi

  if [ "$EMAIL" != "$TARGET_EMAIL_HINT" ]; then
    cat >&2 <<ERR
✗ 登录后身份仍是 ${EMAIL:-未知}，与目标 $TARGET_EMAIL_HINT 不符，终止（配置已还原）

  这条路走不通，换 Token 模式，它不经过浏览器会话：
    1. 无痕窗口打开 https://dash.cloudflare.com/profile/api-tokens（登录 <old-account-email>）
    2. Create Custom Token → 权限：Account · Workers Scripts : Edit、Account · D1 : Edit
    3. 复制 token 后执行：
         CF_TOKEN=<粘贴> bash $0
ERR
    exit 1
  fi
  echo "✓ 身份正确: $EMAIL"
fi

echo
echo "▶ 1/2 配置 REVIEW_API_SECRET"
printf '%s' "$SECRET_VALUE" | npx --yes wrangler secret put REVIEW_API_SECRET

echo
echo "▶ 2/2 部署 submission-bot"
npx --yes wrangler deploy

echo
echo "▶ 线上验证（部署后必须回源确认，不看 deploy 输出）"
sleep 5
code_old=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$BOT_URL/api/submit/form")
code_new=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H "x-review-secret: $SECRET_VALUE" "$BOT_URL/api/admin/review/list")
code_bad=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H "x-review-secret: wrong-key" "$BOT_URL/api/admin/review/list")
echo "  旧接口 /api/submit/form            -> $code_old  (期望 200)"
echo "  新接口 + 正确密钥 /review/list      -> $code_new  (期望 200)"
echo "  新接口 + 错误密钥                    -> $code_bad  (期望 401)"

if [ "$code_new" = "200" ] && [ "$code_bad" = "401" ]; then
  echo "✓ 通过：接口已上线且鉴权生效"
else
  echo "✗ 未通过：部署输出说成功也不算，这里才是判据" >&2
  exit 1
fi
