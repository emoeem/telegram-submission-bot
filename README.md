# Telegram 投稿机器人（跑在 Cloudflare Workers 上）

> **开源版本说明**：本仓库中的 Cloudflare 账号 ID、D1 ID、群/管理员 ID、邮箱、域名和 bot 用户名均已替换为占位符。
> 部署前先 `cp wrangler.example.toml wrangler.toml`，填入自己的值；`wrangler.toml` 已被 gitignore，真实配置不要提交。
> 真实部署的账号/群/回滚信息保存在本地 `.backup/`（同样 gitignored）。
>
> **迁移记录（2026-10-29）**：生产已从旧 Cloudflare 账号迁到新账号；旧 Worker 已删除，旧 D1 保留作归档。
> 下文提到的 `<OLD_ACCOUNT_ID>` / `submission-bot.<old-subdomain>.workers.dev` 均为迁移前示例。
>
> 交接、部署步骤、运维规则和排查手册见 [docs/HANDOVER.md](docs/HANDOVER.md)。

别人私聊机器人 → 机器人一步一步问内容（也可以直接发图）→ 用户确认 → 机器人把投稿发到你的群组。
整套东西跑在 Cloudflare 上：**Workers 处理消息 + D1 存数据**，不需要服务器、不需要域名，免费额度够日常用。

## 功能

- **网页投稿（`/submit`）**：不用 Telegram 也能投——访客打开一个网页表单填内容、传图，提交后走**同一套**审核与发布流程。给国内打不开 Telegram 的人用，见「[网页投稿](#网页投稿不用-telegram-也能投)」
- **评论的评论**：群里回复**别人的评论**同样算评论（`↩️ 张三 回复 李四：…`），作者照样收到通知，点一下就回到那一条下面；作者/管理员的回复也能被继续回复
- **发布话题随时可改**：进目标群的话题里发一次 `/topic` 就发布到那个话题（`/topic off` 回到主聊天）；话题被关闭时**先尝试自动重开**，重开不了也只把这一条临时发到主聊天，**绝不会**把后续投稿永久丢进 General
- 私聊投稿向导：分类 / 标题 / 正文 / 配图 / 署名 / 联系方式，每一步都能「跳过、上一步、取消」
- 文字格式保留：用户写的加粗、链接、代码块会原样带到群里
- **上传 ≠ 发布**：图片/视频只是先收着，流程走完会给出一份**完整预览**（媒体真实回显 + 逐项摘要 + 发布后长什么样的最终文案），**只有用户点「✅ 确认发布」才真正发到群里**
- **确认页可以改、可以退、可以重来**：`✏️ 编辑内容`（跳到任意一项单独改，改完自动回确认页）、`⬅️ 返回上一步`（逐步往回走）、`🗑 管理媒体`（删除单个 / 调整顺序 / 重新选择全部）、`❌ 取消`
- **绝不多发**：幂等守卫 + 投稿级发布租约，连点确认、Telegram 超时重投、程序重启都不会把同一条投稿发两遍；用户和管理员的发布路径共用同一把租约，谁也插不进谁
- **失败可原地重试**：发布失败时给「🔁 重试发布 / ✏️ 返回修改 / ❌ 取消」，重试按**批次**续传——已经发出去的图片/视频和已经成功的目标都不会重发
- **部分失败也可恢复**：多目标里有一个失败，用户直接点「重试发布」就能补上失败的那个；不会出现"以为全成功其实漏发"
- **内容不会走样**：失败后改了正文再重试，数据库内容会同步更新，撤回重发不会发出旧稿
- **有长度兜底**：正文/媒体 caption 超出 Telegram 上限时截断发布，不会让一条投稿永久发不出去
- **多草稿**：手上没写完的投稿可以「🆕 新建投稿」挂起，之后用 `/drafts` 或菜单里的「📂 我的草稿」接着写；草稿连已上传的附件一起保存（默认最多 5 份，`MAX_DRAFTS`）
- **管理员可改媒体**：`✏️ 编辑` 分「📝 改文案」和「🎬 改媒体」。**媒体变少或不变时就地替换**（`editMessageMedia`，点赞/评论/置顶和消息链接全部保留），多出来的媒体消息删掉、正文消息不动；**只有"变多"才回退成删旧消息 + 重发**（Telegram 不允许改变一条消息的媒体个数）
- **人人可用的「💬 评论」入口**：每条已发布投稿的第一个按钮就是「💬 评论」——它是**URL 深链**，任何人点一下都会跳到与机器人的私聊，写下内容后由机器人发到投稿下面。**完全不依赖"机器人能不能收到群消息"**，也不受隐私模式影响
- **普通用户不会再被"只有管理员能用"劝退**：群里的内联按钮对所有人可见，以前普通用户点「💬 回复投稿者」只会看到一句拒绝；现在会明确告诉他点「💬 评论」或直接回复该投稿
- **Telegram 官方评论区**：**任何人在群里回复已发布的投稿都算公开评论**（管理员也一样，机器人不会偷偷删掉或转成私聊），作者会收到私聊通知；回复按钮**直接带评论内容**（不会出现"回复 1 是哪一个"的歧义），作者可以**匿名**回复指定的那一条
- **评论收不到？用 `/diag` 定位**：它按会话类型分别判断——频道没关联讨论组时直接指出"没人能评论"（这才是"只有管理员能评论"的真正原因），普通群则说明"回复投稿默认就能收到"，并给你一个 **🧪 测一测** 按钮做端到端验证
- **作者有评论收件箱**：通知里的「📋 全部评论」能翻看这条投稿的所有评论（分页），每条都能单独回复
- **`/diag` 评论区自检**：直接告诉你"评论为什么收不到"——机器人是否在关联讨论组里、是不是管理员，并给出可执行的修复办法（见下方「评论收不到？」）
- **按钮化管理面板**：`/admin` 不再是文字墙，而是一排按钮（统计 / 待审 / 评论 / 黑名单 / 设置 / 发布目标 / 审计 / 管理员 / 自检）；「📥 待审」是**交互式队列**，点一条看完整内容就能**直接通过/拒绝/编辑**，不用再去审核群里找
- **管理员能回复公开评论**：`/comments 投稿ID` 每条评论带一个「↩️ 评论内容」按钮，点它输入内容就能以「管理员回复」发到评论区
- **评论通知会聚合**：同一投稿在 `COMMENT_NOTIFY_COOLDOWN_SECONDS` 窗口内的多条评论合并进同一条私聊消息（编辑更新，最多列 `COMMENT_NOTIFY_MAX` 条），爆款投稿也不会把作者刷屏
- **作者回复带署名**：投稿时选了「显示我的昵称 / 自定义署名」，回复评论就照这个显示；选了匿名则保持「作者回复：」
- **多模板也能新建投稿**：配了多个模板时，菜单里依然有「🆕 新建投稿」，点了先选类型；**选类型时反悔点「↩️ 回到刚才那份」会原样恢复刚被挂起的草稿**
- **`/approve_all` 不再限制 20 条**：分批循环处理到没有待审核为止（单次硬上限 200，剩余会提示）
- **`/comments` 支持分页**：`/comments 投稿ID [偏移]`，消息底部有「⬅️ 更早 / ➡️ 更新」按钮，几千条评论也能翻

## 代码质量工具链

```bash
npm run lint          # ESLint（flat config）
npm run format        # Prettier 写入
npm run format:check  # 只检查格式
npm run check         # lint + format:check + test 一条龙
```

规则保持很轻：只用 ESLint 官方 recommended，加上"不许 `var`、优先 `const`、未使用变量报错"。
**lint 确实抓到过真 bug**——例如 `sendOrRecover` 的兜底分支引用了不存在的 `from`，发送失败时会二次抛错，
这个路径在 97 个测试里都没被覆盖到。
- **发布中不会永久卡死**：Worker 中途崩溃后，租约过期即自动降级为「发布失败」，用户和管理员都能重新发起
- 配图：最多 10 张（相册形式发布），不做图片中转，直接用 Telegram 自己的 file_id，零存储成本
- 署名方式：匿名 / 显示昵称 / 自定义署名（选「自定义」才追问署名，流程自动分支）
- 两种发布模式：直接发布，或「先发独立审核群 → 管理员点通过 → 才公开」
- 群内管理按钮：回复投稿者、删除投稿、拉黑用户；管理员还会私聊收到回复输入框
- **双向匿名对话**：管理员回复后，投稿者可以直接接着聊，来回多轮，双方互不见身份
- **审核体验**：一键预设驳回理由、审核时直接改文案再发、`/approve_all` 批量通过、审核消息里带该用户历史投稿数
- **防滥用**：敏感词、禁链接、重复投稿检测、新用户冷却、投稿前表情验证
- **多种内容**：图片、视频、文件、语音、位置、投票；图片/视频超过 10 个自动分批发
- **已发布投稿可操作**：编辑、置顶、撤下（可一键重新发布）
- **多发布目标**：Owner 把机器人拉进多个群组/频道后，可分别 `/bind` 授权；D1 保存目标，投稿会发布到所有启用目标
- **发布目标面板**：Owner 私聊 `/targets`，可以逐个启用/停用/删除目标；普通管理员不能授权新目标
- **频道支持**：频道通过 `channel_post` 处理 `/bind`，并要求机器人 Owner 仍是频道管理员
- **Topic 安全回退**：绑定的话题被关闭时自动回退到目标聊天主区，不再因为 `TOPIC_CLOSED` 让整条投稿失败
- **`/my` 查看自己的投稿记录**：最近 10 条的状态（待审/已发布/未通过/发布失败/已撤下）和链接
- **草稿会过期**：未完成的投稿默认保留 7 天（`SESSION_TTL_SECONDS`），过期自动清理，不会突然冒出一份几个月前的旧草稿
- 配置随时改：群里发 `/bind` 授权发布目标、`/targets` 管理目标、`/review on|off` 切换审核模式，**改完立即生效，不用重新部署**
- 自动多标签：按分类和内容类型生成 `#投稿 #图片分享 #图片` 这样的标签 + 可点击的内容链接回执
- 防刷：每个用户单位时间内投稿次数可限制；黑名单 `/ban`
- 中断可续：用户中途离开，回来点「继续上次投稿」接着填
- 数据都在 D1：`/stats` 看统计，随时能导出
- **完整管理员体系**：owner / admin / moderator 三级角色，管理员可运行时添加、移除、调整角色，环境变量中的 owner 受保护
- **管理员后台指令**：`/admins`、`/pending`、`/user`、`/audit`，快速查看管理员、审核队列、用户档案和操作审计
- **用户管理**：`/mute`、`/unmute`、`/note`，可临时禁止投稿、保存管理员备注
- **管理审计**：管理员变更、封禁/解封、静音/备注、发布失败等关键操作写入 D1，便于追踪责任

## 它是怎么工作的

```
用户在 Telegram 私聊机器人
        │
        ▼
Telegram 服务器 ──HTTPS POST──▶ Cloudflare Worker（本项目）
                                     │  读写
                                     ▼
                               D1 数据库（会话 / 投稿 / 黑名单）
                                     │  调 Bot API 发消息
                                     ▼
                              你的群组（或审核群）
```

几个刻意的设计选择：

- **Webhook 而不是轮询**：Worker 没有常驻进程，所以由 Telegram 主动推送到 `/webhook/<密钥>`。
- **先回 200 再处理**：真正的活丢给 `waitUntil` 在后台做，避免 Telegram 等超时后重复投递；同时用 `update_id` 去重。
- **图片不落地**：收到的是 Telegram 的 `file_id`，发布时直接把它交给群，不下载、不转存，省掉 R2 和带宽。
- **相册怎么收**：Webhook 下没法用定时器攒相册，所以机器人对每张图回一个 ✅ 表情（不刷屏），用户发完点「✅ 就这些了」再进入下一步。
- **附件独立成表（`session_media`，append-only）**：相册是多条 update **并发**投递的，如果把附件塞进 `sessions.data` 的数组里做「读-改-写」，后到的写入会覆盖先到的，图片会静默丢失。一行一个附件就没有这个问题。
- **确认是一次显式动作**：上传/预览阶段绝不碰目标群。确认页会先把媒体真实发回私聊让用户核对，再展示「发布后的样子」，用户点「✅ 确认发布」才发。
- **幂等靠数据库，不靠内存**：每条会话有一个 `nonce`，组成幂等键 `w:<用户ID>:<nonce>` 写进 `submission_guards`；「确认」和「通过」都会先抢锁（`INSERT OR IGNORE` + 租约 UPDATE），抢不到的那次只回复「正在发布中」。发布时还会按目标跳过**已经记录过消息**的地方，所以部分失败后重试不会重复发。

## 投稿状态机

一次投稿的状态都放在 `sessions.data.__state.phase`，没有为了它做大重构：

```
IDLE ──/start──▶ COLLECTING ──最后一步答完──▶ PREVIEW
                    ▲                            │
                    │                      点「确认发布」
             「编辑内容 / 返回上一步」             ▼
                    └──────────────────────  PUBLISHING
                                                  │
                        ┌─────────────────────────┴──────────┐
                    成功 ▼                                  失败 ▼
                   PUBLISHED                        FAILED ──「🔁 重试发布」──▶ PUBLISHING
             （清空会话与附件）
```

- `COLLECTING`：正在逐步填写，`sessions.step_id` 指向当前步骤
- `PREVIEW`：确认页（`step_id` 为 NULL）；此时打字不会污染数据
- `PUBLISHING`：已抢到发布租约（120 秒）；Worker 中途崩溃后租约过期会自动降级为 `FAILED`，用户回去点「继续投稿」即可重试
- `FAILED`：保留草稿和投稿记录，给「重试 / 返回修改 / 取消」
- 任何阶段点「取消」都会清空会话与附件；草稿超过 `SESSION_TTL_SECONDS` 自动作废

投稿记录本身的 `submissions.status` 相应扩展为 `pending / publishing / published / rejected / recalled / failed`，所有状态变更都走带条件的 `UPDATE ... WHERE status IN (...)`，并发下只有一次能生效。

## 部署（大约 10 分钟）

### 0. 前置条件

- 本机有 Node.js 18+（`node -v` 能看版本）
- 一个 Telegram 账号，以及一个群组（把机器人拉进去当管理员）
- 本机网络能访问 Cloudflare 和 Telegram（部署动作需要联网；机器人本身跑在云端）

```bash
cd /home/emo/code/bot
npm install          # 只装 wrangler 这一个开发依赖
npx wrangler login   # 浏览器里点一下授权
```

> 没法开浏览器时：在 Cloudflare 后台建一个 API Token（权限：Workers Scripts Edit、D1 Edit），
> 然后 `export CLOUDFLARE_API_TOKEN=xxx` 再执行后面的命令。

### 1. 建 D1 数据库

```bash
npx wrangler d1 create submission-bot-db
```

先复制模板并填入自己的值（`wrangler.toml` 已被 gitignore，不会提交）：

```bash
cp wrangler.example.toml wrangler.toml
```

把 `npx wrangler d1 create` 输出里的 `database_id` 填进本地 `wrangler.toml` 的 `database_id`，
然后建表：

```bash
npm run db:init        # 线上库；本地调试用 npm run db:init:local
```

`schema.sql` 可以放心重复执行：建表语句全部是 `CREATE TABLE IF NOT EXISTS`，本次新增的
`session_media`（附件）和 `submission_guards`（发布幂等）也都是新表，**不需要手动 ALTER 已有表**。

### 2. 存密钥

到 Telegram 里找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，拿到 token，然后：

```bash
npx wrangler secret put BOT_TOKEN           # 粘贴 BotFather 给的 token
npx wrangler secret put WEBHOOK_SECRET      # 随便一串随机字符，比如 openssl rand -hex 24
```

`WEBHOOK_SECRET` 用来防止别人伪造请求打你的机器人，**自己生成一串就好，不用告诉别人**。

想用审核模式就再加一个独立审核群（必须是和发布群不同的会话）：

```bash
npx wrangler secret put ADMIN_CHAT_ID       # 审核群的 -100... ID（群里发 /chatid 可以拿）
```

### 3. 先部署一次

```bash
npm run deploy
```

部署后会得到一个地址，形如 `https://submission-bot.<你的子域>.workers.dev`。

### 4. 告诉 Telegram 往这个地址推送

浏览器打开（把两个变量换成你自己的）：

```
https://submission-bot.<你的子域>.workers.dev/setup?secret=<你的 WEBHOOK_SECRET>
```

看到 `"ok": true` 和 `"bot": "@你的机器人"` 就成功了。这一步同时会注册指令菜单。

### 5. 把机器人接到你的群

1. 私聊机器人发 `/myid`，拿到你自己的用户 ID，填进 [wrangler.example.toml](wrangler.example.toml) 的 `ADMIN_IDS`，然后 `npm run deploy`。
   （这一步必须先做：`ADMIN_IDS` 中的 Owner 是唯一可以授权发布目标的人。）
2. 把机器人拉进你的**群组/频道**。群组需要给机器人管理员权限；频道需要给机器人管理员权限。
3. 在目标群组里，由 Owner 发 `/bind`；如果是论坛群，在希望发布的 Topic 里发 `/bind`。这会把目标写入 D1，**不需要再填群 ID、也不需要重新部署**。
4. 频道同样由 Owner 作为频道管理员发布 `/bind`；机器人会验证 Owner 仍是该频道管理员后登记。
5. 私聊机器人 `/targets`，确认哪些目标启用。投稿默认发布到所有启用目标。

然后私聊机器人发 `/start`，走一遍投稿流程。想增加目标，就把机器人拉进新群/频道后再次 `/bind`；想停用某个目标，在 `/targets` 面板点它即可。

想看当前生效的设置（发布群、审核模式、限流、标签）：群里或私聊发 `/settings`。

### 升级已有部署（老库要跑一次迁移）

如果你是**已经部署过**的库（有真实投稿数据），拉下这次代码后多跑一条命令，把「评论回复」和网页投稿限流需要的表/字段补上：

```bash
npm run db:migrate        # 线上库；本地调试库用 npm run db:migrate:local
```

不跑也不会崩：机器人会自动退化成旧写法（评论照记，只是"回复某条评论"接不上），
群里发 `/diag` 也会明确提示"数据库还缺「评论回复」字段"。**新部署不用做这一步**，
`npm run db:init` 建的库已经带上这些字段。

## 网页投稿（不用 Telegram 也能投）

## 网页投稿（不用 Telegram 也能投）

给「没有 Telegram / 国内打不开 Telegram」的访客准备的网页表单：`GET /submit` 是页面，
`POST /api/submit` 是提交接口，都由同一个 Worker 提供，**不依赖任何外部 CDN**。

它是怎么接进现有流程的：

```
访客打开 /submit → 填内容 + 传图 → 图片直接传给你（换成 Telegram file_id，服务端不存文件）
      → 建投稿记录（user_id = 0，data.__source = "web"）
      → 默认送审：审核卡片（带 ✅通过 / ❌拒绝 / ✏️编辑）发到 ADMIN_CHAT_ID 审核群；
        没配审核群就私聊发给每个管理员
      → 管理员点「通过」→ 走的是和 Telegram 投稿完全相同的 publish()，发到全部启用目标（含话题）
```

几点说明：

- **默认必须审核**（`WEB_REQUIRE_REVIEW=1`）。网页没有 Telegram 身份，直发等于开了个公开灌水位；
  要直发得同时把 `REQUIRE_REVIEW=0`、`WEB_REQUIRE_REVIEW=0` 都设上，风险自负。
- **媒体不留服务器**：文件上传给 Telegram 换 `file_id`，群里发布时直接复用，不占 R2/带宽；
  审核群里能看到真实图片，通过的正是你看到的那几张。**上传时的暂存消息会保留**（审核群里就是审核用的那几条；
  直发模式、又没配审核群时它们会安静地留在第一个管理员的私聊里）——这是故意的：删掉源消息后
  `file_id` 还能不能用，Telegram 没有承诺，留着它「撤下后重新发布 / 失败重试」才一定发得出去。
- **审核卡片里有 IP**（`data.__ip`）：方便追查灌水，也只有管理员能看到。
- **网页投稿没有私聊通知**：投稿者收不到「已通过 / 被评论」的私聊（他本来就没有 TG），
  审核卡片上也会写明这一点；`回复投稿者`「拉黑」这类按钮在网页投稿的卡片上会自动隐藏。
- **防刷**：填表最短用时（`WEB_MIN_FILL_SECONDS`）+ 蜜罐字段 + 算式验证题（`CAPTCHA=1` 时）
  + 按访客 IP 的 D1 原子限流（`WEB_RATE_LIMIT_COUNT` / `WEB_RATE_LIMIT_WINDOW_SECONDS`）
  + 复用敏感词 / 重复内容筛查。这些都是"挡脚本"级别，不是"扛定向攻击"级别。
- **表单是照着提问模板自动生成的**：多模板（`TEMPLATES_JSON`）时网页用 `default` 那个；
  想让网页少问几项，就把 `default` 模板改简单点（`required: false` 的项在网页上可以直接留空）。
- **机器人本体也会推荐它**：配了 `WEB_PUBLIC_URL` 之后，`/start` 的欢迎语里会带一段可复制/转发的
  网页投稿地址，菜单最上面也会多一个「🌐 网页投稿」按钮（原来的 Telegram 向导照旧可用）。
  注意：**已经发出去的老消息里的按钮不会变**（Telegram 不会回改已发送消息），要让用户看到新入口，
  得让机器人重发一次菜单（重新 `/start`）。
- 上传的文件总大小也要控制在 `WEB_MAX_FILES × WEB_MAX_FILE_MB` 之内（超过会直接 413）。

### 国内访问：给 Worker 挂一个能打开的域名

`/submit` 默认在 `https://<你的 worker>.workers.dev/submit`，国内经常打不开。
两种做法（都和机器人本体无关，Webhook 继续走原来的地址）：

**A. 直接给 Worker 绑自定义域名**：Cloudflare 后台 → Workers → 你的脚本 → Settings → Domains & Routes
→ Add Custom Domain（例如 `tougao.example.com`）。简单，但 Cloudflare 免费版在大陆没有境内入口，链路仍会绕道境外。

**B. 前面加一跳国内可用的中继（推荐，本项目线上就是这么跑的）**：
用 Vercel（香港/新加坡边缘，国内可达）把这几条路径反代到 Worker，并**覆写** `x-relay-token`
证明"这个请求确实来自中继"：

```json
// vercel.json（本项目线上实际配置，src 用 $ 锚定，避免误伤 /submissions 等同前缀路径）
{
  "framework": null,
  "routes": [
    {
      "src": "/submit/?$",
      "dest": "https://<你的 worker>.workers.dev/submit",
      "transforms": [
        { "type": "request.headers", "op": "set", "target": { "key": "x-relay-token" },
          "args": "$RELAY_SECRET_BOT", "env": ["RELAY_SECRET_BOT"] }
      ]
    },
    { "src": "/api/submit$", "dest": "https://<你的 worker>.workers.dev/api/submit", "transforms": ["同上"] },
    { "src": "/api/submit/captcha$", "dest": "https://<你的 worker>.workers.dev/api/submit/captcha", "transforms": ["同上"] },
    { "src": "/(.*)", "dest": "https://<原来的站点>/$1", "transforms": ["本站原有的其它路由"] }
  ]
}
```

要点：

- 三条新路由必须放在原有的兜底路由**前面**，其余路径原样保留 → 中继上同时挂着两个站点也不会互相影响；
- `src` 一定要用 `$` 锚定（`/api/submit$`），否则 `/api/submissions` 之类同前缀接口会被误转发；
- 环境变量在 Vercel 项目里加（Production 和 Preview 都要），**改完必须重新部署**，新值才会进入生效的部署；
- Worker 侧存同一个值：

```bash
npx wrangler secret put RELAY_SECRET     # 与 Vercel 里的 RELAY_SECRET_BOT 保持同一个值
```

> 用 `wrangler secret put` 时**不要用管道喂值**（`printf ... | wrangler secret put`）：它会打印
> `✨ Success!` 但存进去的值不可用。要么交互式粘贴，要么直接调 Cloudflare API：
> `PUT /accounts/{account_id}/workers/scripts/{script}/secrets`，body
> `{"name":"RELAY_SECRET","text":"…","type":"secret_text"}`。

有了 `RELAY_SECRET` 之后：只有带对 `x-relay-token` 的请求，机器人才会采信
`x-vercel-proxied-for` / `x-forwarded-for` 里的访客 IP（中继必须**覆写**这些头）；
直连请求一律只信 Cloudflare 注入的 `cf-connecting-ip`，客户端自己伪造的转发头不会被采信。
不配 `RELAY_SECRET` 时行为与改造前一致，回滚只需删掉这个 secret。

**中继头怎么读（2026-10-29 改）**：

| 情况 | 行为 |
|---|---|
| 中继生效，且带了 IP 头 | 取**最后一跳**的值。`x-forwarded-for` 是逐跳追加的，最左边那段由客户端自己控制——取首跳等于把伪造权交给访客（每请求换一个假 IP 就是一个新桶） |
| 中继生效，但一个 IP 头都没带 | **不再回落到 `cf-connecting-ip`**（那是中继自己的出口地址，会让全站访客共用同一个桶），而是记一条 warn 并跳过按 IP 限流，靠 `WEB_DAILY_LIMIT` 全天总闸兜底 |
| 中继未生效 | 只信 `cf-connecting-ip` |

所以中继必须**覆写**（`op: set`）而不是追加 `x-vercel-proxied-for` / `x-forwarded-for`；
用自定义头也行，把 `RELAY_IP_HEADER` 指向它即可。

**怎么验证配对了？** 通过中继提交一条测试投稿，然后看 D1：
`SELECT json_extract(data,'$.__ip') FROM submissions WHERE id = …` ——
里面应该是访客的**真实公网 IP**；如果显示的是 Vercel 的出口地址，说明 `x-relay-token` 没被采信
（密钥不对、或者环境变量改完没重新部署）。日志里出现
`网页投稿：拿不到访客 IP，本次跳过按 IP 限流` 也是同一个信号。


> 踩坑记录：Cloudflare 会把 `x-real-ip` 覆写成"与它相连的那一跳"（即中继自己的出口地址），
> 所以代码**故意不读** `x-real-ip`，否则所有国内访客会被记成同一个 IP、限流桶全部塌成一个。

## 让评论支持回复（已经有部署的看这里）

「评论的评论」需要 `discussion_comments` 多三列：`parent_message_id`、`parent_author_name`、`kind`。
执行一次迁移即可（新库不用）：

```bash
npm run db:migrate          # 线上
npm run db:migrate:local    # 本地调试库
```

`db:migrate` 现在跑的是 `scripts/migrate.mjs`：按文件名顺序把 `migrations/*.sql`
**逐条语句**执行，并且把 `duplicate column name` 当作"已执行过"跳过。

> 为什么改：以前它只指向 `2026-10-16-comment-replies-and-web.sql` 一个文件，而那个文件
> 把 `CREATE TABLE web_thread_messages` 排在三条裸 `ALTER` **后面**。老的库上第一条
> ALTER 就会因"列已存在"失败，D1 整批回滚 → 这张表**永远建不出来**；修好这个的
> `2026-10-17-web-thread-table.sql` 又没有脚本引用。结果就是：代码里到处写着
> "老库缺表要降级"，而那张表在线上真的不存在。现在两个文件都会跑，并且逐条容错。

迁移之后：有人在群里**回复某条评论**（哪怕那条评论是作者/管理员回复的），机器人都会：
找到这条评论属于哪条投稿 → 记下"谁回复了谁" → 通知作者（正文形如 `↩️ 张三 回复 李四：…`）→
作者点「回复」时直接回到那一条评论下面。群里发 `/diag` 可以随时确认迁移状态。


## 配置速查

都在 [wrangler.example.toml](wrangler.example.toml) 的 `[vars]` 里（改完 `npm run deploy` 生效）；
`BOT_TOKEN`、`WEBHOOK_SECRET` 用 `wrangler secret put` 存。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TARGET_CHAT_ID` | 空 | 旧版单目标兼容配置；正式版本推荐留空，由 Owner 用 `/bind` 管理 D1 多目标 |
| `ADMIN_IDS` | 无（必填） | 管理员用户 ID，逗号分隔 |
| `ADMIN_CHAT_ID` | 空 | **独立审核群**的 ID。开启审核模式时必填：审核消息绝不会发到公开的发布群 |
| `REQUIRE_REVIEW` | `0` | `1` = 先审核再公开（也可用 `/review on` 运行时切换，但同样要求已配置 `ADMIN_CHAT_ID`） |
| `TOPIC_ID` | 空 | 旧版单目标 Topic 兼容配置；正式版本由每个 `/bind` 目标自己保存 Topic |
| `DELETE_USER_MESSAGES` | `1` | 用户答完后自动删除他的消息，保持对话干净 |
| `MAX_PHOTOS` | `9` | 单次投稿最多几张图（只影响提示文案） |
| `MAX_ATTACHMENTS` | `10` | **实际生效**的附件上限（图片/视频/文件/语音/位置/投票合计） |
| `MAX_TEXT_LENGTH` | `2000` | 单个文本项字数上限 |
| `SESSION_TTL_SECONDS` | `604800` | 未完成草稿保留多久（秒），`0` = 永不过期 |
| `MAX_DRAFTS` | `5` | 每个用户最多挂起几份草稿 |
| `DISCUSSION_COMMENTS` | `1` | `1` = 接 Telegram 官方评论区（评论通知作者、作者可匿名回复） |
| `COMMENT_NOTIFY_COOLDOWN_SECONDS` | `120` | 评论通知的聚合窗口（秒）：窗口内合并成一条 |
| `COMMENT_NOTIFY_MAX` | `5` | 一条通知消息里最多列几条评论 |
| `WEB_ENABLED` | `1` | `1` = 开启网页投稿（`/submit`，给不用 Telegram 的人，见「网页投稿」一节） |
| `WEB_REQUIRE_REVIEW` | `1` | `1` = 网页投稿必须管理员审核后才发布。**不建议关**：网页没有 Telegram 身份，直发等于开了一个公开灌水位 |
| `WEB_RATE_LIMIT_COUNT` | `3` | 同一访客 IP 在窗口内最多提交几次，`0` = 不限 |
| `WEB_RATE_LIMIT_WINDOW_SECONDS` | `3600` | 网页投稿限流窗口（秒） |
| `WEB_MAX_FILES` | `6` | 网页投稿单条最多几个文件 |
| `WEB_MAX_FILE_MB` | `10` | 网页投稿单个文件上限（MB；图片另有 10MB、视频 20MB 的 Telegram 硬限制） |
| `WEB_MIN_FILL_SECONDS` | `3` | 填表最短用时（秒），比这还快的提交当脚本丢掉 |
| `WEB_TITLE` | 空 | 网页投稿页标题（默认「📮 投稿」） |
| `WEB_INTRO` | 空 | 网页投稿页开头说明（默认一句中文说明） |
| `WEB_PUBLIC_URL` | 空 | 对外的网页投稿地址（例如中继后的 `https://你的域名/submit`）。配了以后机器人菜单最上面会出现「🌐 网页投稿」按钮，欢迎语里也会给一段可转发的地址；留空则不显示 |
| `RELAY_SECRET` | 空（建议用 secret 存） | 网页投稿被中继（Vercel 等）反代时用来采信真实访客 IP，见「网页投稿 → 国内访问」 |
| `RATE_LIMIT_COUNT` | `5` | 限流窗口内最多投稿几次，`0` = 不限 |
| `RATE_LIMIT_WINDOW_SECONDS` | `600` | 限流窗口长度（秒） |
| `CAPTCHA` | `0` | `1` = 投稿前需点对表情验证（防脚本刷投稿） |
| `BANNED_WORDS` | 空 | 敏感词，逗号分隔。审核模式下只标给管理员看，普通模式下直接拦截 |
| `BLOCK_LINKS` | `0` | `1` = 投稿里不允许带链接 |
| `DUPLICATE_WINDOW_SECONDS` | `0` | 同一用户多久内不允许投相同内容（秒），`0` = 不检查 |
| `NEW_USER_COOLDOWN_SECONDS` | `0` | 新用户第一次投稿前要等多少秒，`0` = 不限制 |
| `REJECT_REASONS` | 见下 | 审核时一键驳回的预设理由，逗号分隔 |
| `AUTO_HASHTAGS` | `1` | 按分类和内容类型自动生成多条标签 |
| `TAG` | `#投稿` | 投稿标签 |
| `FOOTER` | 空 | 发布内容末尾的一行小字 |
| `ANONYMOUS_LABEL` | `匿名投稿` | 「匿名」选项的文字，改名时这里也要跟 |
| `PUBLISH_TEMPLATE` | 见下 | 发布格式模板 |
| `TEMPLATES_JSON` | 空 | 覆盖提问流程（见下一节） |
| `TEXTS_JSON` | 空 | 覆盖所有文案（见下一节） |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | 一般不用改；本地测试会指向假服务 |

### 发布格式

`PUBLISH_TEMPLATE` 决定投稿在群里长什么样，可用占位符：

| 占位符 | 内容 |
| --- | --- |
| `{tag}` | 标签，如 `#投稿` |
| `{category}` | 用户在第一个选项步骤里选的分类 |
| `{title}` | 标题（自动加粗，没有则为空） |
| `{body}` | 正文（保留用户写的格式） |
| `{meta}` | 联系方式 + 投稿者署名 |
| `{from}` | 只有署名那一行 |
| `{footer}` | `FOOTER` 的值 |
| `{id}` | 投稿编号，如 `#12` |

默认：

```
{tag} · {category}

{title}
{body}

{meta}
{footer}
```

空的字段会自动合并掉，不会留下多余空行。

### 自定义提问流程

想知道每个步骤长什么样，看 [src/config.js](src/config.js) 里的 `DEFAULT_TEMPLATE`，改完压缩成一行 JSON 填进 `TEMPLATES_JSON` 即可，例如加一个「是否允许转发」的选择题：

```json
{"default":{"name":"默认投稿","steps":[
  {"id":"category","type":"choice","prompt":"这次投稿属于哪一类？","options":["图片分享","文字分享"],"label":"分类"},
  {"id":"body","type":"text","prompt":"写正文吧","required":true,"max_length":2000,"label":"正文"},
  {"id":"photos","type":"media","prompt":"要配图吗？","required":false,"label":"图片"},
  {"id":"author","type":"choice","prompt":"怎么署名？","options":["匿名投稿","显示我的昵称","自定义署名"],"label":"署名方式"},
  {"id":"signature","type":"text","prompt":"请输入想让别人看到的署名","required":true,"max_length":32,"label":"署名","show_if":{"step":"author","equals":"自定义署名"}}
]}}
```

字段说明：`type` 是 `text` / `choice` / `media`；`required: false` 会出现「跳过」按钮；
`show_if` 让这个步骤只在某个选择下才问；`label` 是确认页里显示的名字。
**`id` 只能用 1-24 位字母、数字、下划线或连字符**（它会进入按钮的 callback_data，Telegram 上限 64 字节），
写错会在部署/启动时报出明确错误，而不是默默让某一步的按钮点不动。
配多个模板（比如「图文投稿」「求助提问」分开）就把 `default` 换成多个 key，用户点 `/start` 时会先选类型。

### 改文案

所有提示语都在 [src/texts.js](src/texts.js) 的 `TEXT_DEFAULTS` 里，用 `TEXTS_JSON` 按 key 覆盖，例如：

```toml
TEXTS_JSON = '{"welcome":"👋 欢迎来投稿，写好后我会帮你发到群里。","btnStart":"写投稿"}'
```

## 管理操作

投稿者在私聊里的确认页长这样（**这里还什么都没发出去**）：

| 按钮 | 作用 |
| --- | --- |
| ✅ 确认发布 | 真正发到所有启用的发布目标（审核模式下先发审核群） |
| ✏️ 编辑内容 | 列出所有步骤，点哪项就单独改哪项，改完自动回确认页（已填内容不会丢） |
| ⬅️ 返回上一步 | 从最后一个步骤开始逐步往回改；流程中途点它则保持原来的前进语义 |
| 🗑 管理媒体 | 打开媒体面板：每个附件一行 `⬆️ ⬇️ 🗑`，另有「♻️ 重新选择全部」 |
| ❌ 取消 | 清空这次投稿（含已上传的附件） |

发布失败时给的是：

| 按钮 | 作用 |
| --- | --- |
| 🔁 重试发布 | 接着发没成功的目标；已经发出去的部分不会重复发送 |
| ✏️ 返回修改 | 回到编辑菜单改内容，改完再发 |
| ❌ 取消 | 放弃这次投稿 |

群里的每条投稿下面有按钮：

| 按钮 | 作用 |
| --- | --- |
| 💬 评论 | 投稿上的第一个按钮，**人人可用**：点它跳到机器人私聊，写下内容就公开贴在投稿下面（署名你的昵称），作者会收到通知 |
| 💬 回复投稿者 | 管理员专属：机器人私聊你，你输入内容，它转发给投稿者；**对方能直接接着回你**，来回多轮都行。<br>⚠️ 注意：在群里**直接回复**投稿现在一律算**公开评论**（不再隐式转成私聊），想私下沟通请用这个按钮 |
| 📥 待审队列 | `/admin` →「📥 待审」：列表 → 点一条看完整内容 → 直接通过/拒绝/编辑/回复/拉黑，全程在私聊里完成 |
| ✏️ 编辑 | 先让你选「📝 改文案」或「🎬 改媒体」。改文案：把当前文案私聊给你，改完发回即替换。改媒体：把新的图片/视频/文件发到私聊，点「✅ 就这些了」；**个数和类型没变就逐条就地替换**（`editMessageMedia`，点赞/评论/置顶和链接都保住），**个数变了才删旧消息+重发**（这是 Telegram 的限制）；想改成纯文字就点「🧹 清空并去掉媒体」 |
| 📌 置顶 | 置顶这条投稿（需要机器人有置顶权限） |
| 🧹 撤下 | 从群里删掉，记录保留，机器人会私聊你一个「♻️ 重新发布」按钮 |
| 🚫 拉黑 | 禁止该用户继续投稿；`/unban 用户ID` 解除 |
| ✅ 通过 / ❌ 拒绝 | 只在审核模式出现；拒绝会列出预设理由（也可自己写一句或不给理由） |

想跟投稿者聊天，有两个入口：点按钮，或者**直接在群里回复那条投稿/那条补充消息**——机器人会把你的话转达过去。
投稿者那边不需要任何操作，直接回复机器人发来的消息就能接着聊。

群里或私聊里可用的指令：

```
/start              开始投稿（有未完成草稿时继续上次的）
/cancel             取消当前投稿
/my                 查看自己最近的投稿记录与状态
/drafts             查看/继续/删除挂起的草稿
/help               使用说明
/chatid             查看当前会话 ID
/myid               查看自己的用户 ID
/bind               Owner 授权当前群/当前话题为发布目标
/topic [off|ID]     Owner 把投稿发布位置设成当前话题（在群主聊天区发 = 回到主聊天）
/targets            Owner 管理多个发布目标（启用/停用/删除）
/review on|off      开关审核模式（需要已配置 ADMIN_CHAT_ID）
/settings           查看当前生效的设置
/approve_all        通过所有待审核的投稿
/stats              投稿统计
/ban 用户ID [原因]   拉黑
/unban 用户ID        解除拉黑
/banlist            黑名单
/pending            查看待审核队列
/user 用户ID         查看用户档案和投稿统计
/mute 用户ID 分钟     临时禁止投稿
/unmute 用户ID       解除临时限制
/note 用户ID 内容     保存管理员备注
/comments 投稿ID     查看这条投稿收到的评论（可翻页、可直接回复）
/diag               评论区自检：机器人收得到评论吗（带"测一测"闭环验证）
/audit              查看最近管理操作
/admins             查看管理员列表
/addadmin ID 角色    添加管理员
/deladmin ID         移除管理员
/adminrole ID 角色   调整管理员角色
```

`/bind` 和 `/targets` 只有 Owner 能用；`/review`、`/settings`、`/stats`、`/ban`、`/unban`、`/banlist`、`/pending`、`/user`、`/audit`、`/mute`、`/unmute`、`/note` 由管理员角色控制。

管理员分三级：`owner` / `admin` / `moderator`。`owner` 才能执行 `/addadmin`、`/deladmin`、`/adminrole`；`moderator` 可以审核和处理用户，但不能修改核心配置。环境变量 `ADMIN_IDS` 中的管理员始终是 owner，并受保护。

发布目标、审核设置、管理员和用户管理状态都存 D1，所以运行时修改**不需要重新部署**。发布目标以 `publish_targets` 为主，投稿到多目标时实际消息记录在 `submission_target_messages`；每条已发布消息（含相册的第 2..N 条）都会在 `thread_messages` 里标成 `published_media` / `published_text`，所以**在任意一条下面回复都能关联回这条投稿**，撤回时也能一条不落地删干净。未完成的附件存在 `session_media`，发布幂等靠 `submission_guards`；关键管理动作写入 `audit_logs`，通过 `/audit` 查看。

> 开启审核模式前请先配好 `ADMIN_CHAT_ID`。机器人**不会**把未审核的投稿发到公开的发布群——没配审核群时 `/review on` 会被拒绝，投稿入口也会被拦住，并给出明确提示。

## 本地开发与测试

```bash
npm test              # 端到端测试：假 Telegram + 内存 D1，跑完整投稿流程
npm run dev           # 本地起 Worker（wrangler dev）
```

测试不需要联网，也不需要真的 Telegram 账号：`test/fake-telegram.js` 模拟 Bot API，
`test/d1.js` 用 Node 内置 sqlite 模拟 D1。覆盖了发布、审核通过/拒绝、限流、重复投递去重、
按钮过期、黑名单、中途取消与上一步、以及用户内容转义（防止投稿内容注入群消息）。

[test/regression.test.js](test/regression.test.js) 专门盯住这次修掉的问题：

- **确认前绝不发布**：上传、预览、编辑、打字全程目标群必须一条消息都没有
- **确认页**：媒体真的回显、最终文案真的展示、编辑不丢内容、确认页打字不污染
- **陈旧按钮**：改过内容后旧确认按钮不能发布残缺投稿，取消后旧按钮全部失效
- **绝不重复**：并发双击「确认发布」/「通过」/「重新发布」都只发一次
- **并发相册**：5 张图同时投递必须一张不丢
- **失败恢复**：重试只补没发出去的部分、不重发相册；发布中途崩溃后能恢复
- **评论关联**：在相册第 2..N 条下面回复也能关联回投稿
- **审核安全**：没配独立审核群、或审核群就是发布群时，都拒绝收稿，绝不把草稿发到公开群
- **对抗性评审回归**：附件分批发送中途失败不重发已发部分、失败后改内容要同步数据库、有人正在发布时管理员插不进来、审核卡片不带发布目标的 topic、超长正文截断发布、管理员发布中途崩溃后能恢复
- **多草稿**：新建投稿挂起而不销毁、草稿列表/继续/删除、附件跟着草稿走、超过上限清理最旧的、取消是丢弃不产生草稿
- **管理员改媒体**：旧消息全部删除并用新媒体重发、投稿数据同步、清空媒体变纯文字、空收集不误伤、审核中的投稿重新送审
- **官方评论区**：路人评论通知作者、作者匿名回复挂到原评论下、频道讨论组的 forward_origin 也能关联、管理员回复仍走私聊转达（不记成公开评论）、`/comments` 能列出
- **评论聚合与逐条回复**：窗口内 3 条评论只发 1 条私聊、超过上限会说明只列了最新几条、点「回复 1」就回在第 1 条下面而不是最新那条
- **改媒体就地替换**：媒体变少或不变时用 `editMessageMedia`（消息 id 不变、正文消息不动），只有"变多"才回退删+重发
- **作者回复署名**：匿名投稿保持「作者回复：」，选了昵称/自定义署名的显示对应名字
- **多模板取消不丢草稿**：选类型时点「回到刚才那份」能原样恢复
- **`/comments` 分页**：12 条评论能翻到第 2 页，也能翻回来，每条带"回复"按钮
- **评论区自检**：按会话类型分别判断（频道无讨论组 / 频道+讨论组 / 普通群）、机器人身份三种情况、并给出 `setprivacy` 与 Discussions 两条路径
- **评论区自测闭环**：布置测一测 → 群里有人说话 → 私聊回报结果 → 自动解除
- **群里回复一律算公开评论**：管理员在群里回复不再被删掉或偷偷转私聊，想私下沟通用「回复投稿者」按钮
- **公开评论深链**：普通用户从投稿上的「💬 评论」进私聊写内容 → 公开发到投稿下、评论入库、作者收到通知、能在收件箱里看到
- **管理员按钮不再劝退普通人**：非管理员点管理员按钮会得到"点「💬 评论」或直接回复投稿"的指引
- **深链评论的边界**：空内容/超长/投稿已被撤下都有对应提示，且写错一次不会丢掉"正在评论"的状态
- **作者评论收件箱**：通知里进"全部评论"、逐条回复（提示里带被回复的内容）、别人的投稿看不了
- **按钮化管理面板**：面板入口、待审队列、预览卡片、从面板直接通过、审核员看不到 Owner 专属项
- **管理员回复公开评论**：从评论列表回复，回复挂在被回复的那条下面
- **批量通过不设 20 条上限**：一次 /approve_all 能通过 22 条
- **多模板新建投稿**：有草稿时也能「新建投稿」并选类型

有一个测试基建上的细节：假 Telegram 是**通过 `TELEGRAM_FETCH` 绑定注入**的，不是覆盖 `globalThis.fetch`，
所以同一个进程里可以同时存在多个 harness 而不互相串。

想用真 Telegram 调试本地 worker：需要把 localhost 暴露到公网（`cloudflared tunnel --url http://localhost:8787`），
然后 `GET /setup?secret=...`。

## 常见问题

**机器人在群里没反应？**
群里的普通聊天它不处理（只认 `/指令`），投稿走私聊。确认它已进群且是管理员。

**投稿发不到群里？**
检查 `TARGET_CHAT_ID` 是不是 `-100` 开头的完整 ID（用群里的 `/chatid` 拿最准），以及机器人是不是群管理员。

**想换一个群发布 / 机器人换群了？**
在新群里由 Owner 发一次 `/bind` 即可授权；然后用 `/targets` 管理启用状态。发 `/settings` 可以查看当前目标摘要。

**论坛群（话题群）想把投稿发到指定话题？**
进那个话题，由 Owner 发一次 `/topic`（或 `/bind`）即可，之后所有投稿都发到那个话题；
在群主聊天区发 `/topic off` 就回到主聊天。`/settings` 会显示当前发布话题。
如果那个话题后来被关闭了：机器人会**先尝试自动重开**（需要「管理话题」权限），重开不了就
**只把这一条**临时发到主聊天并私聊提醒管理员——**绑定不会被清掉**，话题重新打开后投稿会自动回到话题里。

**用户上传了图片/视频，怎么还没发出去？**
这是故意的。流程是「选择媒体 → 上传/处理 → 预览 → 用户确认 → 真正发布」。
机器人会把媒体、逐项摘要和「发布后的样子」一起发回私聊，只有用户点「✅ 确认发布」才会发到群里。

**为什么点了两次「确认发布」只发了一条？**
幂等守卫和发布租约在起作用：同一条投稿无论点几次、Telegram 怎么重投、Worker 有没有重启，都只会发一次。
如果上一次发布失败，点「🔁 重试发布」即可——已经成功的目标不会重复发送。

**评论功能好像"只有管理员能评论"/ 评论收不到？**
先在群里发 `/diag`，它按你的实际情况给出结论（不要再凭猜测改设置）：

| 情况 | 结论与做法 |
|---|---|
| **发布目标是频道、且没关联讨论组** | ❗️普通用户在频道里根本不能发言，**没有任何人能评论**。去 频道 → 管理 → **Discussions** 关联一个群，并把机器人设为那个群的**管理员** |
| **频道 + 已关联讨论组** | 评论回复的是 Telegram 转发的副本（不是机器人发的），所以需要机器人是**讨论组管理员**，或在 @BotFather 里 `/setprivacy` → **Disable** |
| **普通群** | 评论就是"回复机器人发的那条投稿"，Telegram 默认就会把这类回复推给机器人，**不需要改任何设置** |

还不确定就点 `/diag` 下面的 **🧪 测一测**：布置后用**另一个非管理员账号**在群里回一句话，
如果你收到机器人的私聊「✅ 测试通过」，说明推送是通的；收不到就是真的没推给机器人，按上表处理。

**审核模式为什么开不起来？**
审核必须发到**独立**的审核群，否则未审核的草稿会直接出现在公开群里。请先设置 `ADMIN_CHAT_ID`
（`npx wrangler secret put ADMIN_CHAT_ID` 或填在 [wrangler.example.toml](wrangler.example.toml) 里），再执行 `/review on`。
审核群**不能**和任何一个发布目标相同（`/review on` 会拒绝，用户点确认时也会被拦住并给出提示）；
`/settings` 会显示当前审核群。审核卡片只发到审核群自己的主消息区，不会带上发布目标的 forum topic。

**点「🗑 删除」没反应？**
机器人需要"删除消息"权限：在群设置里把它升为管理员（或者在管理员权限里单独勾上 Delete Messages）。

**投稿时让用户等 30 秒 / 要做验证？**
这是防滥用功能，分别是 `NEW_USER_COOLDOWN_SECONDS`（新用户冷却）和 `CAPTCHA`（表情验证）。
不想用就在 [wrangler.example.toml](wrangler.example.toml) 里改成 `0` 再 `npm run deploy`。

**标签太多想关掉？**
把 `AUTO_HASHTAGS` 设成 `0`，就只保留 `TAG` 那一个标签。

**改了表结构要重新初始化数据库吗？**
[schema.sql](schema.sql) 可以重复执行，不会清数据：`npm run db:init` 就是幂等的。
（只有给已有表加字段时，需要单独跑一次 `ALTER TABLE ... ADD COLUMN`。）

**怎么知道 webhook 有没有配好？**
浏览器打开 `https://<你的 worker 地址>/setup?secret=<WEBHOOK_SECRET>`，返回里的 `webhook_info.last_error_message` 有报错原因；
没有报错就是正常的。也可以访问 `/health` 看服务活着没。

**Telegram 报 "Wrong response from the webhook"？**
多半是 Worker 抛异常了。Cloudflare 后台 → Workers → 你的脚本 → Logs（实时日志）能看到堆栈；`/health` 是排查路由是否正常的第一步。

**`.workers.dev` 被墙/被 Telegram 判为不可达？**
给 Worker 绑一个自己的域名（Cloudflare 后台 → Workers → 你的脚本 → Settings → Domains & Routes），
用自定义域名重新执行一次 `/setup` 即可。

**想改机器人名字/头像？**
都在 BotFather 里改，和本项目无关。

**数据在哪，怎么备份？**
都在 D1，例如导出全部投稿：

```bash
npx wrangler d1 execute submission-bot --remote --command "SELECT id,status,user_id,full_name,created_at FROM submissions ORDER BY id DESC LIMIT 50"
```

**`Authentication error [code: 10000]` 是怎么回事？**
wrangler 把请求打到了「你当前没有凭据的账号」上。本机如果同时有多个 Cloudflare 账号
（比如还登着别的项目），会出现两种坑：

1. `node_modules/.cache/wrangler/wrangler-account.json` 里存着**上一次部署用的账号**，
   即使你现在 `wrangler login` 的是另一个账号，它也会拿旧账号去发请求 → 10000；
2. 反过来，清掉缓存后又可能把 Worker 建到当前登录的那个账号里（而那里的 D1 数据库并不存在）。

所以本项目的 [wrangler.example.toml](wrangler.example.toml) 里**显式钉了 `account_id`**：所有命令只认这一个账号，
凭据不对就立刻报错，不会静默跑到别的账号去。要在这个账号上部署，用它的 **API Token** 最省事
（不干扰本机其他项目的登录状态）：

```bash
# 在「拥有本项目的那个账号」里建一个 API Token：
#   My Profile → API Tokens → Create Token → Custom token
#   权限：Account · Workers Scripts:Edit、Account · D1:Edit
cd /home/emo/code/bot
export CLOUDFLARE_API_TOKEN=粘贴你的token
export CLOUDFLARE_ACCOUNT_ID=<OLD_ACCOUNT_ID>   # 与 wrangler.toml 里的 account_id 一致
npm run db:migrate && npm run deploy
```

不想用 Token 就 `npx wrangler login` 登录到该账号再执行同样的命令（注意这会把本机的
wrangler 登录态切到该账号，其他项目的部署要再切回来）。

**免费额度够用吗？**
Workers 免费版每天 10 万次请求，D1 免费版每天几百万行读、十万行写。
一次投稿大约消耗 10 次请求、几十行读写——换句话说，日常用量基本碰不到上限
（具体额度以 Cloudflare 官网当前政策为准）。

## 目录结构

```
src/index.js        Worker 入口：路由 /setup、/webhook、/submit、去重、后台处理
src/handlers.js     核心逻辑：私聊投稿流程、状态机、发布、审核、管理员操作、网页投稿落库
src/wizard.js       提问流程纯函数（可见步骤、上下一步、确认页逐项预览）
src/render.js       把投稿渲染成发到群里的文本
src/keyboards.js    内联按钮（步骤 / 确认页 / 媒体管理 / 编辑菜单 / 重试）
src/store.js        D1 数据访问（会话、append-only 附件、幂等守卫、状态 CAS、网页限流）
src/telegram.js     Bot API 客户端（含 429 重试、multipart 上传）
src/config.js       环境变量 → 配置，含提问模板校验与启动自检
src/texts.js        所有文案
src/web.js          网页投稿的 HTTP 层：验证题、限流、表单校验、错误响应
src/web-page.js     /submit 页面（自带样式脚本，不引用外部资源）
src/client-ip.js    访客真实 IP（中继场景下只采信带 RELAY_SECRET 的转发头）
schema.sql          D1 表结构（可重复执行）
migrations/         增量迁移（给已经部署过的老库用：npm run db:migrate）
test/               端到端测试（假 Telegram + 内存 D1）
```
