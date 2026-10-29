# 交接与部署手册（submission-bot）

> 最后更新：2026-10-29
>
> **开源版本说明**：本文中的 Cloudflare 账号/D1 ID、群/管理员 ID、bot 用户名、域名均已替换为占位符。
> 真实部署值保存在本地 `wrangler.toml`（gitignored）和 `.backup/HANDOVER-live.md`（gitignored），不要提交。
> 本文是可复用的交接模板；按第 7 节的 Runbook 填入自己的值即可。
>
> 这份文档给接手的人看：项目做什么、现在跑在哪、代码怎么实现、哪些规则不能破、怎么部署和回滚。
> 用户功能、指令清单和全部环境变量的逐项说明仍以 [README](../README.md) 为准，这里不重复抄一遍。

## 1. 当前线上状态

| 项 | 值 |
| --- | --- |
| Cloudflare 账号 | `<your-cloudflare-account>`，Account ID `<CLOUDFLARE_ACCOUNT_ID>` |
| Worker | `submission-bot` |
| Worker 地址 | https://submission-bot.<your-subdomain>.workers.dev |
| D1 | `submission-bot-db`，UUID `<D1_DATABASE_ID>` |
| Telegram Bot | [@your_bot](https://t.me/your_bot)，bot id `<BOT_ID>` |
| 发布目标 | 超级群 `<TARGET_CHAT_ID>`（论坛群「<your-group-title>」），话题 `<TOPIC_ID>` |
| Owner | Telegram 用户 `<ADMIN_USER_ID>` |
| 公开网页投稿 | https://<your-domain>/submit（302 到问卷平台的 `/submissions?tab=anon`） |
| Worker secrets | `BOT_TOKEN`、`WEBHOOK_SECRET` |
| 旧账号 | `<OLD_ACCOUNT_ID>`（`<old-account-email>`）；旧 Worker 已删除，旧 D1 `<OLD_D1_DATABASE_ID>` 保留作归档 |
| 本地配置 | 复制 `wrangler.example.toml` 为 `wrangler.toml`（已 gitignore）；旧配置在 `.backup/wrangler.toml.old-account-2026-10-29` |

示例部署（2026-10-29 迁移）核对过的数据量：21 条投稿、99 个用户、1 个发布目标、20 条评论、116 条消息关联、
27 条发布守卫、25 个会话、473 条已处理 update、2 条 settings。新库共 22 张表；实际值以你的部署为准。

迁移后的验证结果：

- `npm run check`：166 个测试全过，ESLint / Prettier 通过
- `wrangler deploy --dry-run`：打包 389 KiB（gzip 95 KiB）
- 新 Worker `/health`、`/submit`、`/api/submit/form` 均 200
- webhook 指向新 Worker，`pending 0`、无 `last_error`
- 旧地址 `submission-bot.<old-subdomain>.workers.dev` 返回 404
- 机器人在目标群里是 administrator，且有 `can_manage_topics` 权限
- 用户实测 `/start` 与按钮回调正常

## 2. 这个项目是做什么的

一个跑在 Cloudflare Workers 上的 Telegram 投稿机器人：

1. 用户私聊机器人，按向导填分类、标题、正文、配图、署名、联系方式；
2. 机器人把内容整理成预览，**用户点「✅ 确认发布」之前绝不往群里发**；
3. 确认后发到所有启用的发布目标（群 / 频道 / 论坛话题）；
4. 支持审核模式：先发独立审核群，管理员点通过才公开；
5. 支持在群里的投稿下面评论、作者匿名回复、评论通知聚合；
6. 支持网页投稿（不用 Telegram 的人填表、传文件），走同一套审核/发布流程；
7. 提供管理员面板、待审队列、用户管理、封禁/静音、审计日志、统计等。

### 和问卷平台的关系（很重要）

公开的 `<your-domain>` 由另一个项目 **问卷平台**（`<survey-platform-path>`）承接：

- `<your-domain>/submit` 现在 302 到问卷平台的 `/submissions?tab=anon`；
- 问卷平台已经把自己实现的 `/api/submit/*` 并进它的 D1（它的 migration 0088），
  不再把请求代理给本项目的旧 Worker；
- 问卷平台用 `SUBMISSION_BOT_LEGACY_TOKEN`（就是 @your_bot 的 token）只读读取旧投稿的媒体 file_id；
- 本项目仍然负责 **Telegram 私聊投稿** 和群里的评论/审核/发布。它的 `/submit` 页面在自己的
  workers.dev 域名上仍然可用，但**不再对外宣传**，只是备用入口；`WEB_PUBLIC_URL` 指向
  `https://<your-domain>/submit`，所以机器人菜单给用户的是问卷平台的页面。

结论：改 `<your-domain>`、Vercel 中继或 `/submit` 的行为，会同时影响两个项目；动之前先确认改的是哪一边。

## 3. 架构与代码地图

```
用户私聊 / 群内回复
        │
        ▼
Telegram ──HTTPS POST──▶ Cloudflare Worker（本项目）
                              │ 读写
                              ▼
                        D1（会话 / 投稿 / 评论 / 守卫 / 限流）
                              │ 调 Bot API
                              ▼
                        目标群 / 审核群

访客 ──▶ <your-domain>（Vercel 中继）──▶ 问卷平台 Worker（公开网页投稿）
```

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | Worker 入口：路由 `/health`、`/setup`、`/submit`、`/api/submit*`、`/api/admin/review/*`、`/webhook/<secret>`；先回 200，再用 `waitUntil` 处理 |
| `src/handlers.js` | 核心逻辑：Telegram update 分发、投稿状态机、发布/重试、审核、管理员命令、评论、网页投稿落库 |
| `src/wizard.js` | 提问流程纯函数：可见步骤、上一步/下一步、确认页逐项预览 |
| `src/render.js` | 把投稿渲染成发到群里的文本（`PUBLISH_TEMPLATE`） |
| `src/keyboards.js` | 内联按钮：步骤、确认页、媒体管理、编辑、重试、管理面板 |
| `src/store.js` | D1 数据访问：会话、append-only 附件、幂等守卫、发布租约/CAS、网页限流 |
| `src/telegram.js` | Bot API 客户端：429 重试、multipart 上传、file_id 复用 |
| `src/config.js` | 环境变量 → 配置；模板/文案校验；`checkConfig` 自检 |
| `src/texts.js` | 全部默认文案（可用 `TEXTS_JSON` 覆盖） |
| `src/web.js` | 网页投稿的 HTTP 层：验证题、蜜罐、限流、表单校验、错误响应 |
| `src/web-page.js` | `/submit` 页面：自带 CSS/JS，不引用外部 CDN |
| `src/client-ip.js` | 访客真实 IP：只有带对 `RELAY_SECRET` 的中继头才被采信 |
| `src/admin-review.js` | 后台审核 API（`x-review-secret` + fail-closed） |
| `schema.sql` | 新库完整表结构（可重复执行） |
| `migrations/*.sql` | 老库增量迁移（`npm run db:migrate`） |
| `test/` | 端到端测试：假 Telegram + 内存 D1，不联网 |

## 4. 核心实现要点

### 4.1 Webhook 与去重

- Telegram 只往 `/webhook/<WEBHOOK_SECRET>` 推；路径不对直接 404。
- 收到 update 先返回 200，真正的处理交给 `ctx.waitUntil`，避免 Telegram 等超时后重复投递。
- 每条 update 的 `update_id` 写进 `seen_updates` 去重；重复投递不会重复处理。

### 4.2 投稿状态机

状态在 `sessions.data.__state.phase`，没有为它单独建表：

```
IDLE ──/start──▶ COLLECTING ──最后一步答完──▶ PREVIEW
                    ▲                            │
              编辑/上一步                    「确认发布」
                    │                            ▼
                    └──────────────────────  PUBLISHING
                                                  │
                        ┌─────────────────────────┴──────────┐
                    成功 ▼                                  失败 ▼
                   PUBLISHED                        FAILED ──「重试」──▶ PUBLISHING
```

- `COLLECTING`：`sessions.step_id` 指向当前步骤；
- `PREVIEW`：确认页，此时打字不会污染数据；
- `PUBLISHING`：已抢到发布租约（120 秒），Worker 崩溃后租约过期自动降级为 `FAILED`；
- `FAILED`：保留草稿和投稿记录，用户可以重试/返回修改/取消；
- 取消会清空会话和附件；草稿超过 `SESSION_TTL_SECONDS` 自动作废。

### 4.3 发布幂等与部分失败

- 每条会话有 `nonce`，幂等键 `w:<用户ID>:<nonce>` 写进 `submission_guards`；
- 「确认」和「通过」都先抢锁（`INSERT OR IGNORE` + 租约 UPDATE），抢不到只回复「正在发布中」；
- 发布时按目标记录已经发出去的消息，重试只补没成功的目标，不会重复发；
- 所有投稿状态变更走带条件的 `UPDATE ... WHERE status IN (...)`，并发下只有一次生效。

### 4.4 媒体

- 图片/视频只保存 Telegram 的 `file_id`，不下载、不转存，不占 R2；
- 未完成的附件存在 `session_media`（append-only，一行一个附件），避免并发相册的读-改-写丢图；
- 网页投稿上传的文件也是先传给 Telegram 换 `file_id`，审核群看到的正是要发布的那几张；
- 上传时的 Telegram 源消息会保留，保证撤下后重新发布/失败重试时 `file_id` 仍可用。

### 4.5 评论

- 群里回复机器人发的投稿（包括相册第 2..N 条）都算公开评论，按 `thread_messages` 关联回投稿；
- 回复别人的评论也算评论（`discussion_comments.parent_message_id` / `parent_author_name` / `kind`）；
- 作者收到聚合私聊通知（`COMMENT_NOTIFY_COOLDOWN_SECONDS`），可以匿名回复到指定评论下；
- 管理员想私下沟通用「回复投稿者」按钮，不会把私聊内容记成公开评论；
- 评论收不到时先发 `/diag`，它按频道/讨论组/普通群分别给结论，并提供「测一测」。

### 4.6 网页投稿

- `GET /submit` 页面 + `GET /api/submit/captcha` 验证题 + `POST /api/submit` 提交；
- 防刷：填表最短用时、蜜罐字段、算式验证题、按 IP 的 D1 原子限流、全天硬上限、待审积压上限；
- 验证题是 HMAC 无状态令牌，`2026-10-29` 起用 `web_form_nonces` 做一次性登记，防止同一 token 重放；
- 网页投稿默认必须管理员审核（`WEB_REQUIRE_REVIEW=1`），因为网页没有 Telegram 身份；
- 中继场景下只采信带对 `x-relay-token` 的转发头，并且取 `x-forwarded-for` 的**最后一跳**；
  没有 IP 头时跳过按 IP 限流，靠 `WEB_DAILY_LIMIT` 全天总闸兜底；故意不读 `x-real-ip`。

### 4.7 管理员体系

- 三级角色：`owner` / `admin` / `moderator`；
- 环境变量 `ADMIN_IDS` 里的用户始终是 owner 且受保护；
- 发布目标、审核开关、管理员、封禁/静音/备注都存在 D1，运行时改，不用重新部署；
- 关键管理动作写 `audit_logs`，`/audit` 查看。

## 5. 关键数据表

| 表 | 用途 |
| --- | --- |
| `sessions` / `session_media` | 当前投稿会话与未完成附件（append-only） |
| `drafts` / `draft_media` | 挂起的多份草稿 |
| `submissions` | 投稿主记录与状态 |
| `publish_targets` / `submission_target_messages` | 发布目标，以及每个目标实际发出的消息 |
| `thread_messages` | 群里每条已发布消息 → 投稿的映射（评论/撤回用） |
| `submission_guards` | 发布幂等键与租约 |
| `seen_updates` | Telegram update 去重 |
| `discussion_comments` / `comment_notifications` | 公开评论、评论通知聚合 |
| `users` / `bans` / `user_controls` | 用户档案、黑名单、静音/备注 |
| `admins` / `admin_actions` / `audit_logs` | 管理员角色与操作审计 |
| `settings` | 运行时设置（如目标群/话题） |
| `web_rate_limits` / `web_thread_messages` / `web_form_nonces` | 网页限流、网页投稿对话、验证题一次性登记 |

## 6. 项目规则（接手后必须遵守）

1. **账号必须钉死**：`wrangler.toml` 的 `account_id` 是唯一依据，不依赖本机当前登录账号。
   改配置或换机器后先 `npx wrangler whoami`，再 `npx wrangler deploy --dry-run` 确认 D1 指向正确。
2. **secret 不要用管道喂**：`printf ... | wrangler secret put` 会打印成功但存进去的值不可用。
   用交互式粘贴，或直接调 Cloudflare API `PUT /workers/scripts/<name>/secrets`。
   secret 不写进 `wrangler.toml`、不提交 `.dev.vars`。
3. **迁移先于部署**：代码依赖新表/新列时，先 `npm run db:migrate` 再 `npm run deploy`。
   新库用 `npm run db:init`；同时把新结构补进 `schema.sql`，否则新装环境会缺表。
4. **部署前跑质量门**：`npm run check`（ESLint + Prettier + 166 个测试）。测试不联网，
   用假 Telegram + 内存 D1，别为了“先上线”跳过。
5. **发布安全不能绕**：用户没点「确认发布」绝不发群；不要绕过 `submission_guards` 和租约；
   不要把未审核草稿发到公开群。开审核模式前必须配**独立**的 `ADMIN_CHAT_ID`，不能和发布目标同一个会话。
6. **网页投稿默认审核**：`WEB_REQUIRE_REVIEW=1` 不要随便关；网页没有 Telegram 身份，直发等于开公开灌水位。
7. **IP 只信中继的最后一跳**：只有带对 `RELAY_SECRET` 的请求才采信转发头；中继必须 `op: set` 覆写，
   不要追加；不要读 `x-real-ip`（Cloudflare 会把它改成中继自己的出口地址）。
8. **跨项目边界**：`<your-domain>`、Vercel 中继、问卷平台的 `/api/submit/*` 属于另一个项目。
   改公开网页投稿、审核后台或中继前，先确认问卷平台那边的部署和 D1；两边不要各实现一份“通过/发布”。
9. **媒体不落地**：继续用 Telegram `file_id`，不要为了“方便”下载到 R2/KV；上传源消息不要删，
   删除后 `file_id` 是否还能用没有承诺。
10. **破坏性操作先备份**：删 Worker/D1、改表、批量修数据前，先 `wrangler d1 export` 全量导出，
    并把导出文件放到仓库外或安全存储。`.backup/` 是 gitignored，新克隆的仓库里没有它。
11. **话题安全回退**：话题被关闭时先尝试自动重开；重开不了只把当条临时发主聊天，不要永久清掉绑定，
    也不要把后续投稿永久丢进 General。
12. **代码风格**：ESLint 官方 recommended + 不许 `var`、优先 `const`、未使用变量报错；Prettier 统一格式。
    提交前 `npm run format` 或 `npm run check`。

## 7. 部署与更新 Runbook

### 7.1 当前账号的日常更新（最常见）

```bash
cd /home/emo/code/bot
npx wrangler whoami           # 应显示 <your-cloudflare-account> / <CLOUDFLARE_ACCOUNT_ID>
npm run check                 # lint + format + 166 tests
npm run deploy                # 使用 wrangler.toml 里的新账号和新 D1
```

只有改了表结构才需要先跑：

```bash
npm run db:migrate            # 线上库；逐条执行 migrations/*.sql，容忍"列已存在"
```

部署后验证：

```bash
curl -s https://submission-bot.<your-subdomain>.workers.dev/health
curl -s -o /dev/null -w '%{http_code}\n' https://submission-bot.<your-subdomain>.workers.dev/submit
curl -s https://submission-bot.<your-subdomain>.workers.dev/api/submit/form | head -c 200
```

Worker 名字不变，workers.dev 地址不变，**不需要重新注册 webhook**。只有改了 `WEBHOOK_SECRET`
或换了域名/Worker 名时才需要重新访问 `/setup`。

### 7.2 从零/新账号部署

1. 前置：Node.js 18+、Cloudflare 账号、Telegram bot token、一个群/频道。
2. `npm install`
3. 确认账号：`npx wrangler login`，`npx wrangler whoami` 核对 account id。
4. 复制配置模板并填值：
   ```bash
   cp wrangler.example.toml wrangler.toml
   ```
   建库：`npx wrangler d1 create submission-bot-db`，把输出的 UUID 填进 `wrangler.toml` 的
   `database_id`；`account_id` 也改成目标账号。
5. 建表（新库）：`npm run db:init`
6. 存密钥：

   ```bash
   npx wrangler secret put BOT_TOKEN        # 交互式粘贴
   npx wrangler secret put WEBHOOK_SECRET   # openssl rand -hex 32
   # 可选：
   npx wrangler secret put ADMIN_CHAT_ID    # 独立审核群
   npx wrangler secret put RELAY_SECRET     # 走国内中继时
   ```

7. 部署：`npm run deploy`
8. 注册 webhook（把两个值换成自己的）：

   ```
   https://submission-bot.<子域>.workers.dev/setup?secret=<WEBHOOK_SECRET>
   ```

   返回 `ok: true`、`bot: "@..."` 即成功；`problems` 里如果提示没有发布群，是正常的下一步。
9. 把 bot 拉进群/频道并设为管理员；Owner 在群里（论坛群在目标话题里）发 `/bind`。
10. 私聊 bot 发 `/myid` 确认自己的 ID 在 `ADMIN_IDS`；`/targets` 确认发布目标启用；
    `/review on` 如需审核模式（必须先配 `ADMIN_CHAT_ID`）。
11. 私聊 `/start` 走一遍投稿，确认只在点「确认发布」后才出现在群里。

### 7.3 老库迁移到新库（这次 2026-10-29 的做法）

1. 备份旧库（全量 + 纯数据）：

   ```bash
   npx wrangler d1 export submission-bot-db --remote --output old-full.sql -y
   npx wrangler d1 export submission-bot-db --remote --output old-data.sql --no-schema -y
   ```

2. 新库先建好完整 schema：`npm run db:init`（在已指向新库的配置下）。
3. 纯数据文件去掉 `sqlite_sequence` 行，把 `INSERT INTO` 改成 `INSERT OR REPLACE INTO`，
   再导入新库：

   ```bash
   grep -v '^INSERT INTO "sqlite_sequence"' old-data.sql \
     | sed 's/^INSERT INTO "/INSERT OR REPLACE INTO "/' > import.sql
   npx wrangler d1 execute submission-bot-db --remote --file=import.sql -y
   ```

4. 逐表核对行数、`settings`、`publish_targets`、`admins`，再切换 webhook。
5. 旧 Worker 删除前先确认新 Worker 的 `/setup` 返回 `problems: []`；旧 D1 建议保留一段时间。

### 7.4 回滚

- 代码回滚：Cloudflare 后台的 Deployments/版本历史回滚，或用旧配置重新 `npm run deploy`。
- 整账号回滚：旧配置 `.backup/wrangler.toml.old-account-2026-10-29` + 旧账号 token，重新部署旧 Worker，
  再把 webhook 指回旧 URL。具体步骤见 `.backup/webhook-rollback.txt`。
- 数据回滚：旧 D1 `<OLD_D1_DATABASE_ID>` 仍在旧账号；本地 `.backup/` 有全量/纯数据备份。
  注意旧 D1 是冻结点，迁移后新产生的数据不会自动同步回去。

## 8. 排查手册

| 现象 | 多半原因 | 处理 |
| --- | --- | --- |
| `Authentication error [code: 10000]` | 本机登录账号与 `wrangler.toml` 的 `account_id` 不一致 | `npx wrangler whoami`；用正确的账号登录或 API Token |
| `code: 7403` | 当前凭据无权访问该账号/D1 | 核对 account id 和 token 权限（Workers Scripts:Edit、D1:Edit） |
| 设置完 secret 仍提示「缺少 BOT_TOKEN」 | 用了管道喂值，存进去的是空值 | `npx wrangler secret list` 看名字；重新交互式/走 API 设置 |
| `/setup` 报 `Telegram setWebhook 失败：Not Found` | `BOT_TOKEN` 为空或无效 | 先 `getMe` 验证 token；重设 secret |
| 群里 @ 机器人没反应 | webhook 未注册/路径不对/Worker 异常 | `getWebhookInfo` 看 url 和 `last_error_message`；`npx wrangler tail` 看堆栈 |
| 审核模式开不起来 | 没配 `ADMIN_CHAT_ID`，或它和发布目标是同一个会话 | 配独立审核群；`/settings` 核对 |
| 评论收不到 | 频道没关联讨论组 / 机器人不是讨论组管理员 / privacy mode | 群里发 `/diag`，按它给的结论处理；必要时 BotFather `/setprivacy` Disable |
| 网页投稿 IP 全是同一个 | 中继没覆写转发头，或 `RELAY_SECRET` 不一致 | 看 D1 `data.__ip`；确认 Vercel 用 `op: set` 覆写并重新部署 |
| 网页投稿被 413/拒绝 | 文件数/大小超限、全天硬上限、待审积压 | 看 `WEB_MAX_FILES` / `WEB_MAX_FILE_MB` / `WEB_DAILY_LIMIT` / `WEB_PENDING_LIMIT` |
| 旧地址 `submission-bot.<old-subdomain>.workers.dev` 404 | 旧 Worker 已在 2026-10-29 删除 | 预期行为；要回滚见 7.4 |
| `<your-domain>/submit` 302 到 `/submissions` | 公开网页投稿由问卷平台承接 | 预期行为，不是本 Worker 的 `/submit` |
| 发布失败/卡在发布中 | Telegram 超时、租约未过期、目标权限不足 | 等租约过期（120s）或点「重试发布」；检查机器人是否群管理员 |

## 9. 交接清单

**访问权限**

- [ ] Cloudflare 账号 `<your-cloudflare-account>`（`<CLOUDFLARE_ACCOUNT_ID>`），至少 Workers Scripts:Edit、D1:Edit
- [ ] 旧账号 `<OLD_ACCOUNT_ID>` 的只读/归档访问（旧 D1 还在那边）
- [ ] Telegram BotFather 里 @your_bot 的管理权
- [ ] 目标群/频道管理员（机器人需要发消息、删消息、置顶、管理话题）
- [ ] `<your-domain>` / Vercel 中继 / 问卷平台（`<survey-platform-path>`）的访问权

**密钥与备份**

- [ ] Worker secrets：`BOT_TOKEN`、`WEBHOOK_SECRET`（在 Cloudflare 后台/`wrangler secret list` 可看名字）
- [ ] 本地 `.dev.vars` 只有 `WEBHOOK_SECRET`；本地调试要补 `BOT_TOKEN`
- [ ] `.backup/` 里有旧配置、旧 D1 全量/纯数据备份、旧 Worker 脚本、回滚说明
- [ ] **`.backup/` 和 `.dev.vars` 都是 gitignored**：交接时把备份复制到仓库外的安全位置，
      不要指望新克隆的仓库里自带

**待办/可选项**

- [ ] 撤销迁移时使用的旧 Cloudflare API Token（`cfat_…`）
- [ ] 观察几天后，决定是否删除旧账号的 D1 `<OLD_D1_DATABASE_ID>`（删前确认备份可用）
- [ ] 如需新 Worker 自己的 `/submit` 发邮件通知，补 `RESEND_API_KEY`、`MAIL_FROM`
      （旧 Worker 的 secret 明文读不回来，需要重新拿 key）
- [ ] 如需后台审核 API，补 `REVIEW_API_SECRET`；当前公开审核在问卷平台，不补也能跑
- [ ] 如需更换 bot token：同时更新本 Worker 的 `BOT_TOKEN`、问卷平台的
      `SUBMISSION_BOT_LEGACY_TOKEN`，并重新 `/setup`
- [ ] 仓库目前还没有 git 提交记录；交接前建议先提交一版（不要提交 `.dev.vars`、`.backup/`）

## 10. 已知限制

- 本项目的网页投稿 `/submit` 是旧版入口，公开入口已经并到问卷平台；两边不要同时对外宣传。
- 新 Worker 只迁移了 `BOT_TOKEN` / `WEBHOOK_SECRET`；旧 Worker 的 `MAIL_FROM`、`RESEND_API_KEY`、
  `RELAY_SECRET`、`REVIEW_API_SECRET` 没有迁移（Cloudflare 不回显 secret 明文，且当前公开流程不需要）。
- 不存媒体文件，只存 Telegram `file_id`；如果 Telegram 侧源消息被删，旧 file_id 的可用性没有保证。
- 旧 D1 是归档快照，不会跟新库双向同步。
- 免费额度：Workers 每天 10 万请求、D1 每天有读写行数上限；日常投稿量远低于上限。
