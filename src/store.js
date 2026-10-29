/** D1 数据访问层：所有状态都存在 D1，Worker 本身无状态。 */

import { nowSeconds } from './utils.js';

// SQLite 在列不存在时给的是 "no such column: x" / "table t has no column named x"。
// 老库没执行 ALTER 就靠它退化成旧写入（见 rememberComment）。
function isMissingColumnError(error) {
  return /no such column|has no column named/i.test(String(error?.message ?? error));
}

/** 表还没建出来（迁移没跑全）。和缺列是两件事：缺表时整条查询都不可用。 */
function isMissingTableError(error) {
  return /no such table/i.test(String(error?.message ?? error));
}

/**
 * 「这条投稿来自网页」的判定条件。
 *
 * `__source` 不是列，是塞在 `data` JSON 里的标记（见 createWebSubmission）。
 * 用 json_extract 而不是 LIKE：正文里完全可能出现 `"__source":"web"` 这几个
 * 字符，LIKE 会把那条正常投稿一起算成网页投稿。
 */
const WEB_SOURCE_WHERE = "json_extract(data, '$.__source') = 'web'";

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---------- 更新去重 ----------

  /** 返回 true 表示这条更新没见过（新更新）。 */
  async markUpdateSeen(updateId) {
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO seen_updates (update_id, created_at) VALUES (?, ?)')
      .bind(updateId, nowSeconds())
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async pruneSeenUpdates(olderThanSeconds = 86400) {
    await this.db
      .prepare('DELETE FROM seen_updates WHERE created_at < ?')
      .bind(nowSeconds() - olderThanSeconds)
      .run();
  }

  // ---------- 多发布目标 ----------

  async listPublishTargets({ enabledOnly = false } = {}) {
    const sql = enabledOnly
      ? 'SELECT * FROM publish_targets WHERE enabled = 1 ORDER BY id'
      : 'SELECT * FROM publish_targets ORDER BY id';
    const result = await this.db.prepare(sql).all();
    return result.results ?? [];
  }

  async getPublishTarget(id) {
    return this.db.prepare('SELECT * FROM publish_targets WHERE id = ?').bind(id).first();
  }

  async getPublishTargetByChat(chatId) {
    return this.db.prepare('SELECT * FROM publish_targets WHERE chat_id = ?').bind(chatId).first();
  }

  async upsertPublishTarget({ chatId, chatType, title, username, threadId = null, threadTitle = null, addedBy }) {
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO publish_targets (chat_id, chat_type, title, username, thread_id, thread_title, enabled, added_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         chat_type = excluded.chat_type, title = excluded.title, username = excluded.username,
         thread_id = excluded.thread_id, thread_title = excluded.thread_title, enabled = 1, updated_at = excluded.updated_at`,
      )
      .bind(chatId, chatType, title ?? null, username ?? null, threadId, threadTitle ?? null, addedBy, now, now)
      .run();
    return this.getPublishTargetByChat(chatId);
  }

  async setPublishTargetThread(id, threadId = null, threadTitle = null) {
    await this.db
      .prepare('UPDATE publish_targets SET thread_id = ?, thread_title = ?, updated_at = ? WHERE id = ?')
      .bind(threadId, threadTitle, nowSeconds(), id)
      .run();
  }

  async setPublishTargetEnabled(id, enabled) {
    await this.db
      .prepare('UPDATE publish_targets SET enabled = ?, updated_at = ? WHERE id = ?')
      .bind(enabled ? 1 : 0, nowSeconds(), id)
      .run();
  }

  async deletePublishTarget(id) {
    await this.db.prepare('DELETE FROM publish_targets WHERE id = ?').bind(id).run();
    // 多目标模式下删除最后一个目标后，不应被旧版 settings 里的历史话题重新复活。
    const remaining = await this.db.prepare('SELECT COUNT(*) AS n FROM publish_targets').first();
    if (!remaining?.n) {
      await this.clearSetting('target_chat_id');
      await this.clearSetting('target_thread_id');
    }
  }

  async saveSubmissionTargetMessages(submissionId, targetId, messageIds) {
    const ids = (messageIds ?? []).filter(Boolean);
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO submission_target_messages (submission_id, target_id, message_ids, primary_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id, target_id) DO UPDATE SET message_ids = excluded.message_ids, primary_message_id = excluded.primary_message_id, updated_at = excluded.updated_at`,
      )
      .bind(submissionId, targetId, JSON.stringify(ids), ids[ids.length - 1] ?? null, now, now)
      .run();
  }

  async listSubmissionTargetMessages(submissionId) {
    const result = await this.db
      .prepare(
        `SELECT stm.*, pt.chat_id, pt.title, pt.username, pt.thread_id
       FROM submission_target_messages stm JOIN publish_targets pt ON pt.id = stm.target_id
       WHERE stm.submission_id = ? ORDER BY stm.target_id`,
      )
      .bind(submissionId)
      .all();
    return (result.results ?? []).map((row) => ({ ...row, messageIds: safeArray(row.message_ids) }));
  }

  /**
   * 某个投稿在各聊天里已经发出去的消息，按 chat_id 汇总。
   * 用于「重试发布」时跳过已经发过的目标，避免部分失败后重试导致重复。
   * direction 约定：published_media（媒体）/ published_text（正文）。
   */
  async publishedState(submissionId) {
    const result = await this.db
      .prepare(
        `SELECT chat_id, direction, COUNT(*) AS n FROM thread_messages
          WHERE submission_id = ? AND direction IN ('published_media', 'published_text')
          GROUP BY chat_id, direction`,
      )
      .bind(submissionId)
      .all();
    const map = new Map();
    for (const row of result.results ?? []) {
      const entry = map.get(row.chat_id) ?? { media: 0, text: 0 };
      if (row.direction === 'published_media') entry.media = row.n;
      if (row.direction === 'published_text') entry.text = row.n;
      map.set(row.chat_id, entry);
    }
    return map;
  }

  async firstPublishedMediaId(submissionId, chatId) {
    return this.firstPublishedMessageId(submissionId, chatId, 'published_media');
  }

  async firstPublishedMessageId(submissionId, chatId, direction) {
    const row = await this.db
      .prepare(
        `SELECT message_id FROM thread_messages
          WHERE submission_id = ? AND chat_id = ? AND direction = ?
          ORDER BY message_id LIMIT 1`,
      )
      .bind(submissionId, chatId, direction)
      .first();
    return row?.message_id ?? null;
  }

  /** 某个聊天里已发布的全部消息 id（按发送顺序）。用于续传和 replyTo 锚点。 */
  async listPublishedMessageIdsForChat(submissionId, chatId, direction) {
    const result = await this.db
      .prepare(
        `SELECT message_id FROM thread_messages
          WHERE submission_id = ? AND chat_id = ? AND direction = ?
          ORDER BY message_id`,
      )
      .bind(submissionId, chatId, direction)
      .all();
    return (result.results ?? []).map((row) => row.message_id);
  }

  /** 撤回时用：所有已发布消息（含相册的第 2..N 条和多目标）。 */
  async listPublishedMessageIds(submissionId) {
    const result = await this.db
      .prepare(
        `SELECT chat_id, message_id FROM thread_messages
          WHERE submission_id = ? AND direction IN ('published_media', 'published_text')`,
      )
      .bind(submissionId)
      .all();
    return result.results ?? [];
  }

  /** 重新发布前清掉旧的发布映射（旧消息已经删了）。 */
  async clearPublishedMessages(submissionId) {
    await this.db
      .prepare(
        `DELETE FROM thread_messages
          WHERE submission_id = ? AND direction IN ('published_media', 'published_text')`,
      )
      .bind(submissionId)
      .run();
  }

  /** 用户自己的投稿历史（/my）。 */
  async listUserSubmissions(userId, limit = 10) {
    const result = await this.db
      .prepare("SELECT * FROM submissions WHERE user_id = ? AND status != 'deleted' ORDER BY id DESC LIMIT ?")
      .bind(userId, limit)
      .all();
    return (result.results ?? []).map(hydrateSubmission);
  }

  // ---------- 用户 ----------

  async getSetting(key) {
    const row = await this.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return row ? row.value : null;
  }

  async setSetting(key, value) {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value === null || value === undefined ? null : String(value), nowSeconds())
      .run();
  }

  async clearSetting(key) {
    await this.db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
  }

  async touchUser(from) {
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO users (user_id, username, full_name, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           username = excluded.username,
           full_name = excluded.full_name,
           last_seen = excluded.last_seen`,
      )
      .bind(from.id, from.username ?? null, [from.first_name, from.last_name].filter(Boolean).join(' '), now, now)
      .run();
  }

  async userCount() {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM users').first();
    return row?.n ?? 0;
  }

  async getUserProfile(userId) {
    return this.db
      .prepare('SELECT user_id, username, full_name, first_seen, last_seen FROM users WHERE user_id = ?')
      .bind(userId)
      .first();
  }

  // ---------- 投稿进度 ----------

  async getSession(userId) {
    const row = await this.db.prepare('SELECT * FROM sessions WHERE user_id = ?').bind(userId).first();
    if (!row) return null;
    return {
      userId: row.user_id,
      templateId: row.template_id,
      stepId: row.step_id,
      data: safeParse(row.data),
      promptChatId: row.prompt_chat_id,
      promptMessageId: row.prompt_message_id,
      updatedAt: row.updated_at,
    };
  }

  async saveSession(session) {
    await this.db
      .prepare(
        `INSERT INTO sessions (user_id, template_id, step_id, data, prompt_chat_id, prompt_message_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           template_id = excluded.template_id,
           step_id = excluded.step_id,
           data = excluded.data,
           prompt_chat_id = excluded.prompt_chat_id,
           prompt_message_id = excluded.prompt_message_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        session.userId,
        session.templateId,
        session.stepId ?? null,
        JSON.stringify(session.data ?? {}),
        session.promptChatId ?? null,
        session.promptMessageId ?? null,
        nowSeconds(),
      )
      .run();
  }

  async clearSession(userId) {
    await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  }

  // ---------- 会话媒体（append-only） ----------

  /**
   * 追加一个附件。返回 inserted=false 表示同一个 unique_id 已经收过了。
   * 用独立行而不是往 sessions.data 的数组里 push，避免并发相册互相覆盖。
   */
  async appendSessionMedia(userId, stepId, attachment) {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO session_media (user_id, step_id, ordinal, kind, payload, unique_id, created_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM session_media WHERE user_id = ? AND step_id = ?), ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        stepId,
        userId,
        stepId,
        attachment.kind,
        JSON.stringify(attachment),
        attachment.uniqueId ?? null,
        nowSeconds(),
      )
      .run();
    return {
      inserted: (result.meta?.changes ?? 0) > 0,
      id: Number(result.meta?.last_row_id ?? 0),
    };
  }

  async listSessionMedia(userId, stepId = null) {
    const sql = stepId
      ? 'SELECT * FROM session_media WHERE user_id = ? AND step_id = ? ORDER BY ordinal, id'
      : 'SELECT * FROM session_media WHERE user_id = ? ORDER BY step_id, ordinal, id';
    const result = await this.db
      .prepare(sql)
      .bind(...(stepId ? [userId, stepId] : [userId]))
      .all();
    return (result.results ?? []).map((row) => ({
      mediaId: row.id,
      stepId: row.step_id,
      ...safeParse(row.payload),
    }));
  }

  async countSessionMedia(userId, stepId) {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM session_media WHERE user_id = ? AND step_id = ?')
      .bind(userId, stepId)
      .first();
    return row?.n ?? 0;
  }

  async deleteSessionMedia(userId, mediaId) {
    const result = await this.db
      .prepare('DELETE FROM session_media WHERE id = ? AND user_id = ?')
      .bind(mediaId, userId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async clearSessionMedia(userId, stepId = null) {
    if (stepId) {
      await this.db.prepare('DELETE FROM session_media WHERE user_id = ? AND step_id = ?').bind(userId, stepId).run();
      return;
    }
    // 全清（finishSession / cancel）只清向导暂存的媒体；`__edit:` 前缀是管理员
    // 「改媒体」流程的暂存区，由它自己的完成/取消清理——否则管理员在编辑媒体
    // 中途顺手 /cancel 一次投稿向导，正在改的媒体就被静默清空了。
    await this.db
      .prepare(
        "DELETE FROM session_media WHERE user_id = ? AND (step_id IS NULL OR substr(step_id, 1, 7) <> '__edit:')",
      )
      .bind(userId)
      .run();
  }

  /** 上移/下移一个附件：把整段 ordinal 重排，简单可靠。 */
  async moveSessionMedia(userId, stepId, mediaId, direction) {
    const rows = await this.listSessionMedia(userId, stepId);
    const index = rows.findIndex((row) => Number(row.mediaId) === Number(mediaId));
    if (index < 0) return false;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= rows.length) return false;
    const ids = rows.map((row) => row.mediaId);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await this.db.batch(
      ids.map((id, position) =>
        this.db.prepare('UPDATE session_media SET ordinal = ? WHERE id = ?').bind(position, id),
      ),
    );
    return true;
  }

  // ---------- 投稿幂等守卫 ----------

  async getGuard(key) {
    return this.db.prepare('SELECT * FROM submission_guards WHERE guard_key = ?').bind(key).first();
  }

  /** 第一次占用这个幂等键；返回 true 表示这次调用创建了它（即抢到了）。 */
  async claimGuard(key, now, lockUntil) {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO submission_guards (guard_key, submission_id, status, locked_until, created_at, updated_at)
         VALUES (?, NULL, 'locked', ?, ?, ?)`,
      )
      .bind(key, lockUntil, now, now)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** 原子加锁：只有未发布且租约已过期/未占用时才成功。这是防重复发布的核心。 */
  async lockGuard(key, now, lockUntil) {
    const result = await this.db
      .prepare(
        `UPDATE submission_guards
            SET status = 'locked', locked_until = ?, updated_at = ?
          WHERE guard_key = ? AND status != 'published'
            AND (locked_until IS NULL OR locked_until < ?)`,
      )
      .bind(lockUntil, now, key, now)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async setGuardSubmission(key, submissionId) {
    await this.db
      .prepare('UPDATE submission_guards SET submission_id = ?, updated_at = ? WHERE guard_key = ?')
      .bind(submissionId, nowSeconds(), key)
      .run();
  }

  /** status: 'locked' | 'submitted'（已送审）| 'published'。 */
  async setGuardStatus(key, status) {
    await this.db
      .prepare('UPDATE submission_guards SET status = ?, locked_until = NULL, updated_at = ? WHERE guard_key = ?')
      .bind(status, nowSeconds(), key)
      .run();
  }

  /** 释放租约，允许用户重试（投稿记录和已发出的目标消息都保留）。 */
  async releaseGuard(key) {
    await this.db
      .prepare(
        "UPDATE submission_guards SET locked_until = NULL, updated_at = ? WHERE guard_key = ? AND status = 'locked'",
      )
      .bind(nowSeconds(), key)
      .run();
  }

  /** 把租约复位成可再次获取（重新发布前用）。 */
  async resetGuard(key, submissionId = null) {
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO submission_guards (guard_key, submission_id, status, locked_until, created_at, updated_at)
         VALUES (?, ?, 'locked', NULL, ?, ?)
         ON CONFLICT(guard_key) DO UPDATE SET
           status = 'locked', locked_until = NULL,
           submission_id = COALESCE(excluded.submission_id, submission_guards.submission_id),
           updated_at = excluded.updated_at`,
      )
      .bind(key, submissionId, now, now)
      .run();
  }

  /** 只有当前状态在 fromStatuses 里才改成 toStatus，避免并发重复处理。 */
  async casSubmissionStatus(id, fromStatuses, toStatus) {
    if (fromStatuses.length === 0) return false;
    const placeholders = fromStatuses.map(() => '?').join(', ');
    const result = await this.db
      .prepare(`UPDATE submissions SET status = ? WHERE id = ? AND status IN (${placeholders})`)
      .bind(toStatus, id, ...fromStatuses)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  // ---------- 投稿记录 ----------

  async createSubmission({ userId, username, fullName, templateId, data, contentHash, flags }) {
    const result = await this.db
      .prepare(
        `INSERT INTO submissions
           (user_id, username, full_name, template_id, data, status, content_hash, flags, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        userId,
        username ?? null,
        fullName ?? null,
        templateId,
        JSON.stringify(data),
        contentHash ?? null,
        flags && flags.length > 0 ? flags.join(',') : null,
        nowSeconds(),
      )
      .run();
    return Number(result.meta?.last_row_id ?? 0);
  }

  async updateSubmission(id, patch) {
    const allowed = [
      'status',
      'publish_chat_id',
      'publish_message_id',
      'media_chat_id',
      'media_message_id',
      'message_ids',
      'published_at',
      'content_hash',
      'flags',
      'override_text',
    ];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => patch[key]);
    await this.db
      .prepare(`UPDATE submissions SET ${assignments} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  async getSubmission(id) {
    const row = await this.db.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
    return row ? hydrateSubmission(row) : null;
  }

  /** 重试/编辑后同步正文：否则数据库留的是旧内容，撤回重发会发出旧稿。 */
  async updateSubmissionContent(id, { data, contentHash, flags, username, fullName }) {
    await this.db
      .prepare(
        `UPDATE submissions
            SET data = ?, content_hash = ?, flags = ?, username = ?, full_name = ?
          WHERE id = ?`,
      )
      .bind(
        JSON.stringify(data ?? {}),
        contentHash ?? null,
        flags && flags.length > 0 ? flags.join(',') : null,
        username ?? null,
        fullName ?? null,
        id,
      )
      .run();
  }

  async clearSubmissionTargetMessages(submissionId) {
    await this.db.prepare('DELETE FROM submission_target_messages WHERE submission_id = ?').bind(submissionId).run();
  }

  async countRecentSubmissions(userId, windowSeconds) {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND created_at >= ?')
      .bind(userId, nowSeconds() - windowSeconds)
      .first();
    return row?.n ?? 0;
  }

  /** 同一用户、同样内容、时间窗口内是否投过（防重复）。可排除某条投稿自己。 */
  async countSameContent(userId, contentHash, windowSeconds = 0, excludeId = null) {
    if (!contentHash) return 0;
    const since = windowSeconds > 0 ? nowSeconds() - windowSeconds : 0;
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM submissions
         WHERE user_id = ? AND content_hash = ? AND created_at >= ? AND status != 'deleted'
           AND (? IS NULL OR id != ?)`,
      )
      .bind(userId, contentHash, since, excludeId, excludeId)
      .first();
    return row?.n ?? 0;
  }

  /** 某位投稿者的历史战绩，审核时给管理员参考。 */
  async userSubmissionStats(userId) {
    const rows = await this.db
      .prepare('SELECT status, COUNT(*) AS n FROM submissions WHERE user_id = ? GROUP BY status')
      .bind(userId)
      .all();
    const stats = { total: 0, published: 0, rejected: 0, pending: 0, recalled: 0, deleted: 0 };
    for (const row of rows.results ?? []) {
      // publishing 只是 pending 的中间态，统计口径上并入待审
      const status = row.status === 'publishing' ? 'pending' : row.status;
      stats[status] = (stats[status] ?? 0) + row.n;
      stats.total += row.n;
    }
    return stats;
  }

  async listPending(limit = 20) {
    const result = await this.db
      .prepare("SELECT * FROM submissions WHERE status = 'pending' ORDER BY id LIMIT ?")
      .bind(limit)
      .all();
    return (result.results ?? []).map(hydrateSubmission);
  }

  /**
   * 网页投稿的列表（管理后台审核用）。
   *
   * 网页投稿和 Telegram 投稿同一张表，靠 `data.__source === 'web'` 区分。这里用
   * json_extract 而不是 LIKE '%"__source":"web"%' —— 正文里完全可能出现同样
   * 的字符串，LIKE 会把那条正常投稿误判成网页投稿。
   */
  async listWebSubmissionsForReview({ status = null, limit = 50, offset = 0 } = {}) {
    const params = [];
    const where = [WEB_SOURCE_WHERE];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const result = await this.db
      .prepare(`SELECT * FROM submissions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all();
    return (result.results ?? []).map(hydrateSubmission);
  }

  /** 网页投稿的总数 / 某个状态的数量，给分页和角标用。 */
  async countWebSubmissionsForReview({ status = null } = {}) {
    const params = [];
    const where = [WEB_SOURCE_WHERE];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM submissions WHERE ${where.join(' AND ')}`)
      .bind(...params)
      .first();
    return Number(row?.total ?? 0);
  }

  // ---------- 匿名对话线程 ----------

  async rememberThreadMessage(chatId, messageId, submissionId, direction) {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_messages (chat_id, message_id, submission_id, direction, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(chatId, messageId, submissionId, direction, nowSeconds())
      .run();
  }

  /** 消息 → 投稿：既查对话记录，也兜住"群里那条已发布的投稿"。 */
  async findSubmissionByMessage(chatId, messageId) {
    const row = await this.db
      .prepare('SELECT submission_id FROM thread_messages WHERE chat_id = ? AND message_id = ?')
      .bind(chatId, messageId)
      .first();
    if (row) return row.submission_id;
    const submission = await this.db
      .prepare(
        `SELECT id FROM submissions
         WHERE (publish_chat_id = ? AND (publish_message_id = ? OR media_message_id = ?))
            OR (media_chat_id = ? AND media_message_id = ?)
         LIMIT 1`,
      )
      .bind(chatId, messageId, messageId, chatId, messageId)
      .first();
    return submission ? submission.id : null;
  }

  /**
   * 站内积压的待审投稿数。用途是给网页投稿加一道"后端闸门"：
   * 未审核的稿件堆到上限就停止收新稿，而不是继续往库里灌。
   *
   * 为什么按 pending 而不是按"今天收了多少"：正常业务里管理员会持续清理，
   * pending 会自然回落；被刷的时候 pending 只增不减，闸门会一直关着。
   */
  async countPendingSubmissions() {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'").first();
    return Number(row?.n ?? 0);
  }

  async stats() {
    const [total, published, pending, rejected, today, users] = await this.db.batch([
      this.db.prepare('SELECT COUNT(*) AS n FROM submissions'),
      this.db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'published'"),
      this.db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'"),
      this.db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'rejected'"),
      this.db
        .prepare('SELECT COUNT(*) AS n FROM submissions WHERE created_at >= ?')
        .bind(Math.floor(Date.now() / 1000) - 86400),
      this.db.prepare('SELECT COUNT(*) AS n FROM users'),
    ]);
    return {
      total: total.results?.[0]?.n ?? 0,
      published: published.results?.[0]?.n ?? 0,
      pending: pending.results?.[0]?.n ?? 0,
      rejected: rejected.results?.[0]?.n ?? 0,
      today: today.results?.[0]?.n ?? 0,
      users: users.results?.[0]?.n ?? 0,
    };
  }

  // ---------- 多草稿 ----------

  async countDrafts(userId) {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE user_id = ?').bind(userId).first();
    return row?.n ?? 0;
  }

  async listDrafts(userId, limit = 10) {
    const result = await this.db
      .prepare(
        // updated_at 只有秒级精度，加 id 兜底保证"最新的在前"是确定的
        'SELECT id, template_id, step_id, title, updated_at FROM drafts WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?',
      )
      .bind(userId, limit)
      .all();
    return result.results ?? [];
  }

  async getDraft(userId, draftId) {
    const row = await this.db
      .prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?')
      .bind(draftId, userId)
      .first();
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      templateId: row.template_id,
      stepId: row.step_id,
      data: safeParse(row.data),
      title: row.title,
      updatedAt: row.updated_at,
    };
  }

  async createDraft({ userId, templateId, stepId, data, title }) {
    const now = nowSeconds();
    const result = await this.db
      .prepare(
        `INSERT INTO drafts (user_id, template_id, step_id, data, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, templateId, stepId ?? null, JSON.stringify(data ?? {}), title ?? null, now, now)
      .run();
    return Number(result.meta?.last_row_id ?? 0);
  }

  async deleteDraft(userId, draftId) {
    const owned = await this.db
      .prepare('SELECT id FROM drafts WHERE id = ? AND user_id = ?')
      .bind(draftId, userId)
      .first();
    if (!owned) return false;
    await this.db.prepare('DELETE FROM draft_media WHERE draft_id = ?').bind(draftId).run();
    await this.db.prepare('DELETE FROM drafts WHERE id = ?').bind(draftId).run();
    return true;
  }

  /** 挂起：把当前会话的附件复制进草稿。 */
  async copySessionMediaToDraft(userId, draftId) {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO draft_media (draft_id, step_id, ordinal, kind, payload, unique_id, created_at)
         SELECT ?, step_id, ordinal, kind, payload, unique_id, created_at FROM session_media WHERE user_id = ?`,
      )
      .bind(draftId, userId)
      .run();
  }

  /** 恢复：把草稿的附件复制回当前会话。 */
  async copyDraftMediaToSession(userId, draftId) {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO session_media (user_id, step_id, ordinal, kind, payload, unique_id, created_at)
         SELECT ?, step_id, ordinal, kind, payload, unique_id, created_at FROM draft_media WHERE draft_id = ?`,
      )
      .bind(userId, draftId)
      .run();
  }

  async countDraftMedia(draftId) {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM draft_media WHERE draft_id = ?').bind(draftId).first();
    return row?.n ?? 0;
  }

  // ---------- Telegram 官方评论区 ----------

  async rememberComment({
    chatId,
    messageId,
    submissionId,
    threadId = null,
    authorId,
    authorName,
    text,
    parentMessageId = null,
    parentAuthorName = null,
    kind = 'user',
  }) {
    const now = nowSeconds();
    const values = [
      chatId,
      messageId,
      submissionId,
      threadId ?? null,
      authorId ?? null,
      authorName ?? null,
      text ?? null,
      now,
    ];
    try {
      await this.db
        .prepare(
          `INSERT INTO discussion_comments
             (chat_id, message_id, submission_id, thread_id, author_id, author_name, text,
              parent_message_id, parent_author_name, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, message_id) DO UPDATE SET
             submission_id = excluded.submission_id, thread_id = excluded.thread_id,
             author_id = excluded.author_id, author_name = excluded.author_name, text = excluded.text,
             parent_message_id = excluded.parent_message_id, parent_author_name = excluded.parent_author_name,
             kind = excluded.kind`,
        )
        .bind(
          chatId,
          messageId,
          submissionId,
          threadId ?? null,
          authorId ?? null,
          authorName ?? null,
          text ?? null,
          parentMessageId ?? null,
          parentAuthorName ?? null,
          kind,
          now,
        )
        .run();
      return true;
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      // 老库还没有"评论回复"的三列（README 里有 ALTER 语句）：退回旧写入。
      // 评论本身照常记录，只是丢掉了回复关系，等管理员执行迁移即可恢复。
      await this.db
        .prepare(
          `INSERT INTO discussion_comments (chat_id, message_id, submission_id, thread_id, author_id, author_name, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, message_id) DO UPDATE SET
             submission_id = excluded.submission_id, thread_id = excluded.thread_id,
             author_id = excluded.author_id, author_name = excluded.author_name, text = excluded.text`,
        )
        .bind(...values)
        .run();
      return false;
    }
  }

  /** 数据库是否已经有"评论回复"字段（老库要手动 ALTER，/diag 会据此提示）。 */
  async supportsCommentReplies() {
    try {
      await this.db
        .prepare('SELECT parent_message_id, parent_author_name, kind FROM discussion_comments LIMIT 1')
        .all();
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 网页投稿：身份 / 收件箱 / 匿名对话 ----------

  /** 按浏览器身份取出这个人的网页投稿（最新在前）。 */
  async listWebSubmissions(viewerToken, limit = 20) {
    const result = await this.db
      .prepare(
        `SELECT * FROM submissions
          WHERE json_extract(data, '$.__source') = 'web' AND json_extract(data, '$.__viewer') = ?
          ORDER BY id DESC LIMIT ?`,
      )
      .bind(viewerToken, limit)
      .all();
    return result.results ?? [];
  }

  async getWebThread(submissionId, limit = 50) {
    // 老库可能还没有 web_thread_messages 表（迁移没跑全）：退化成"没有留言"，不要 500。
    // 这句注释以前只是注释——缺表时异常会一路冒到收件箱页面，把整页打成 500。
    try {
      const result = await this.db
        .prepare('SELECT * FROM web_thread_messages WHERE submission_id = ? ORDER BY id ASC LIMIT ?')
        .bind(submissionId, limit)
        .all();
      return result.results ?? [];
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      return [];
    }
  }

  async addWebThreadMessage({ submissionId, direction, text }) {
    const result = await this.db
      .prepare(
        `INSERT INTO web_thread_messages (submission_id, direction, text, seen_by_author, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .bind(submissionId, direction, text, nowSeconds())
      .run();
    return Number(result.meta?.last_row_id ?? 0);
  }

  async markWebThreadSeenByAuthor(submissionId) {
    try {
      await this.db
        .prepare(
          "UPDATE web_thread_messages SET seen_by_author = 1 WHERE submission_id = ? AND direction = 'to_author'",
        )
        .bind(submissionId)
        .run();
    } catch (error) {
      // 和 getWebThread 同一类：老库缺表时这里抛出去，收件箱整页 500
      if (!isMissingTableError(error)) throw error;
    }
  }

  /** 收件箱里这条投稿未读的管理员留言数。 */
  async countUnreadWebThread(submissionId) {
    try {
      return await this.countUnreadWebThreadStrict(submissionId);
    } catch {
      return 0;
    }
  }

  async countUnreadWebThreadStrict(submissionId) {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM web_thread_messages WHERE submission_id = ? AND direction = 'to_author' AND seen_by_author = 0",
      )
      .bind(submissionId)
      .first();
    return Number(row?.n ?? 0);
  }

  /** 网页投稿者上次查看收件箱的时间（存进 submissions.data.__seenAt）。 */
  async touchWebSeen(submissionId, seenAt) {
    await this.db
      .prepare("UPDATE submissions SET data = json_set(data, '$.__seenAt', ?) WHERE id = ?")
      .bind(seenAt, submissionId)
      .run();
  }

  // ---------- 网页投稿限流 ----------

  async getWebRateLimit(key) {
    const row = await this.db.prepare('SELECT count FROM web_rate_limits WHERE key = ?').bind(key).first();
    return Number(row?.count ?? 0);
  }

  /**
   * 累加一个限流桶并返回累加后的计数。
   * UPSERT 是单条语句，D1 保证原子；随后的 SELECT 就算被并发挤了一下也只会把计数读大，
   * 对限流来说偏保守，可以接受（不用 RETURNING，兼容性更稳）。
   */
  async bumpWebRateLimit(key, windowStart) {
    await this.db
      .prepare(
        `INSERT INTO web_rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN web_rate_limits.window_start = excluded.window_start THEN web_rate_limits.count + 1 ELSE 1 END,
           window_start = excluded.window_start`,
      )
      .bind(key, windowStart)
      .run();
    const row = await this.db.prepare('SELECT count FROM web_rate_limits WHERE key = ?').bind(key).first();
    return Number(row?.count ?? 1);
  }

  async pruneWebRateLimits(olderThanSeconds = 86400, now = nowSeconds()) {
    // now 由调用方传入（生产=真实时钟，测试=注入的假时钟）：prune 与限流桶
    // 必须用同一只钟，否则注入假时钟的部署/测试会被真时钟判成"过期"清桶，
    // 限流计数随机归零（这正是每小时偶发一次的测试假失败的根因）。
    await this.db
      .prepare('DELETE FROM web_rate_limits WHERE window_start < ?')
      .bind(now - olderThanSeconds)
      .run();
  }

  // ---------- 表单令牌的一次性登记 ----------

  /**
   * 登记一个表单令牌的 nonce，返回它的状态：
   * - `'consumed'`    第一次见到，允许这次提交
   * - `'reused'`      已经用过，必须拒绝（重放）
   * - `'unavailable'` 老库还没有这张表，退化放行（由调用方打 warn）
   *
   * 之前 verifyFormToken 是纯无状态的：签名、有效期、答案三道都对，同一个 token
   * 就能在 30 分钟内无限重放——"人机验证"只挡住了不会写脚本的人。这里用主键冲突
   * 做一次性登记，单条 INSERT 由 D1 保证原子。
   */
  async consumeFormNonce(nonce, expiresAt) {
    try {
      const result = await this.db
        .prepare('INSERT INTO web_form_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING')
        .bind(nonce, expiresAt)
        .run();
      return Number(result.meta?.changes ?? 0) > 0 ? 'consumed' : 'reused';
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      return 'unavailable';
    }
  }

  async pruneFormNonces() {
    try {
      await this.db.prepare('DELETE FROM web_form_nonces WHERE expires_at < ?').bind(nowSeconds()).run();
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }

  async latestComment(submissionId) {
    return this.db
      .prepare(
        'SELECT * FROM discussion_comments WHERE submission_id = ? ORDER BY created_at DESC, message_id DESC LIMIT 1',
      )
      .bind(submissionId)
      .first();
  }

  async listComments(submissionId, limit = 20, offset = 0) {
    const result = await this.db
      .prepare(
        `SELECT * FROM discussion_comments WHERE submission_id = ?
          ORDER BY created_at DESC, message_id DESC LIMIT ? OFFSET ?`,
      )
      .bind(submissionId, limit, Math.max(0, offset))
      .all();
    return result.results ?? [];
  }

  /** 就地删掉某条已发布消息后，把映射也一起忘掉。 */
  async forgetPublishedMessage(chatId, messageId) {
    await this.db
      .prepare(
        `DELETE FROM thread_messages
          WHERE chat_id = ? AND message_id = ? AND direction IN ('published_media', 'published_text')`,
      )
      .bind(chatId, messageId)
      .run();
  }

  async countComments(submissionId) {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM discussion_comments WHERE submission_id = ?')
      .bind(submissionId)
      .first();
    return row?.n ?? 0;
  }

  async getComment(chatId, messageId) {
    return this.db
      .prepare('SELECT * FROM discussion_comments WHERE chat_id = ? AND message_id = ?')
      .bind(chatId, messageId)
      .first();
  }

  /** 窗口内**最新的** limit 条评论（按时间正序返回），用于拼聚合后的通知正文。 */
  async listCommentsSince(submissionId, since, limit = 5) {
    const result = await this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM discussion_comments
            WHERE submission_id = ? AND created_at >= ?
            ORDER BY created_at DESC, message_id DESC LIMIT ?
         ) ORDER BY created_at ASC, message_id ASC`,
      )
      .bind(submissionId, since, limit)
      .all();
    return result.results ?? [];
  }

  /** 最近有评论的投稿（管理面板用）。 */
  async recentCommentedSubmissions(limit = 5) {
    const result = await this.db
      .prepare(
        `SELECT submission_id AS id, COUNT(*) AS count, MAX(created_at) AS latest
           FROM discussion_comments GROUP BY submission_id ORDER BY latest DESC LIMIT ?`,
      )
      .bind(limit)
      .all();
    return result.results ?? [];
  }

  async getCommentNotification(submissionId, userId) {
    return this.db
      .prepare('SELECT * FROM comment_notifications WHERE submission_id = ? AND user_id = ?')
      .bind(submissionId, userId)
      .first();
  }

  async upsertCommentNotification({ submissionId, userId, chatId, messageId, windowStart, count }) {
    await this.db
      .prepare(
        `INSERT INTO comment_notifications (submission_id, user_id, chat_id, message_id, window_start, count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(submission_id, user_id) DO UPDATE SET
           chat_id = excluded.chat_id, message_id = excluded.message_id,
           window_start = excluded.window_start, count = excluded.count`,
      )
      .bind(submissionId, userId, chatId, messageId, windowStart, count)
      .run();
  }

  // ---------- 黑名单 ----------

  async isBanned(userId) {
    const row = await this.db.prepare('SELECT user_id FROM bans WHERE user_id = ?').bind(userId).first();
    return Boolean(row);
  }

  async ban(userId, reason) {
    await this.db
      .prepare(
        `INSERT INTO bans (user_id, reason, created_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason`,
      )
      .bind(userId, reason ?? null, nowSeconds())
      .run();
  }

  async unban(userId) {
    await this.db.prepare('DELETE FROM bans WHERE user_id = ?').bind(userId).run();
  }

  async listBans(limit = 20) {
    const result = await this.db
      .prepare('SELECT user_id, reason, created_at FROM bans ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all();
    return result.results ?? [];
  }

  // ---------- 管理员角色 ----------

  async seedAdmins(adminIds) {
    const now = nowSeconds();
    for (const userId of adminIds ?? []) {
      await this.db
        .prepare(
          `INSERT INTO admins (user_id, role, added_by, created_at, updated_at)
         VALUES (?, 'owner', ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
        )
        .bind(userId, userId, now, now)
        .run();
    }
  }

  async getAdmin(userId) {
    return this.db.prepare('SELECT * FROM admins WHERE user_id = ?').bind(userId).first();
  }

  async listAdmins() {
    const result = await this.db
      .prepare(
        "SELECT user_id, role, added_by, created_at, updated_at FROM admins ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at",
      )
      .all();
    return result.results ?? [];
  }

  async addAdmin(userId, role, addedBy) {
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO admins (user_id, role, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by, updated_at = excluded.updated_at`,
      )
      .bind(userId, role, addedBy, now, now)
      .run();
  }

  async removeAdmin(userId) {
    await this.db.prepare('DELETE FROM admins WHERE user_id = ?').bind(userId).run();
  }

  async countOwners() {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner'").first();
    return row?.n ?? 0;
  }

  async audit(actorId, action, targetType = null, targetId = null, detail = null) {
    await this.db
      .prepare(
        'INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(actorId, action, targetType, targetId == null ? null : String(targetId), detail, nowSeconds())
      .run();
  }

  async listAudit(limit = 20) {
    const result = await this.db
      .prepare(
        'SELECT id, actor_id, action, target_type, target_id, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ?',
      )
      .bind(limit)
      .all();
    return result.results ?? [];
  }

  async getUserAdminData(userId) {
    const [user, stats, ban, control] = await this.db.batch([
      this.db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId),
      this.db.prepare('SELECT status, COUNT(*) AS n FROM submissions WHERE user_id = ? GROUP BY status').bind(userId),
      this.db.prepare('SELECT * FROM bans WHERE user_id = ?').bind(userId),
      this.db.prepare('SELECT * FROM user_controls WHERE user_id = ?').bind(userId),
    ]);
    const counts = { total: 0, published: 0, pending: 0, rejected: 0, recalled: 0, deleted: 0 };
    for (const row of stats.results ?? []) {
      const status = row.status === 'publishing' ? 'pending' : row.status;
      counts[status] = (counts[status] ?? 0) + row.n;
      counts.total += row.n;
    }
    return {
      user: user.results?.[0] ?? null,
      stats: counts,
      ban: ban.results?.[0] ?? null,
      control: control.results?.[0] ?? null,
    };
  }

  async setUserNote(userId, note, actorId) {
    await this.db
      .prepare(
        `INSERT INTO user_controls (user_id, note, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(userId, note ?? null, actorId, nowSeconds())
      .run();
  }

  async muteUser(userId, seconds, actorId) {
    await this.db
      .prepare(
        `INSERT INTO user_controls (user_id, muted_until, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET muted_until = excluded.muted_until, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(userId, nowSeconds() + Math.max(0, seconds), actorId, nowSeconds())
      .run();
  }

  async isMuted(userId) {
    const row = await this.db.prepare('SELECT muted_until FROM user_controls WHERE user_id = ?').bind(userId).first();
    return Boolean(row?.muted_until && row.muted_until > nowSeconds());
  }

  // ---------- 管理员待办 ----------

  async setAdminAction(adminId, action, submissionId) {
    await this.db
      .prepare(
        `INSERT INTO admin_actions (admin_id, action, submission_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(admin_id) DO UPDATE SET
           action = excluded.action,
           submission_id = excluded.submission_id,
           created_at = excluded.created_at`,
      )
      .bind(adminId, action, submissionId, nowSeconds())
      .run();
  }

  async getAdminAction(adminId, maxAgeSeconds = 900) {
    const row = await this.db
      .prepare('SELECT action, submission_id, created_at FROM admin_actions WHERE admin_id = ?')
      .bind(adminId)
      .first();
    if (!row) return null;
    if (row.created_at < nowSeconds() - maxAgeSeconds) {
      await this.clearAdminAction(adminId);
      return null;
    }
    return { action: row.action, submissionId: row.submission_id };
  }

  async clearAdminAction(adminId) {
    await this.db.prepare('DELETE FROM admin_actions WHERE admin_id = ?').bind(adminId).run();
  }
}

function safeParse(text) {
  try {
    const value = JSON.parse(text ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function safeArray(text) {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function hydrateSubmission(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    templateId: row.template_id,
    data: safeParse(row.data),
    status: row.status,
    contentHash: row.content_hash,
    flags: row.flags ? String(row.flags).split(',').filter(Boolean) : [],
    overrideText: row.override_text,
    publishChatId: row.publish_chat_id,
    publishMessageId: row.publish_message_id,
    mediaChatId: row.media_chat_id,
    mediaMessageId: row.media_message_id,
    messageIds: safeArray(row.message_ids),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}
