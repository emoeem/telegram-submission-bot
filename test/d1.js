/** 用 Node 内置的 node:sqlite 模拟 Cloudflare D1，方便本地跑集成测试。 */

import { DatabaseSync } from 'node:sqlite';

function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function createD1(schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }

    bind(...params) {
      return new Statement(this.sql, params.map(normalize));
    }

    first() {
      const row = db.prepare(this.sql).get(...this.params);
      return row === undefined ? null : row;
    }

    all() {
      return { results: db.prepare(this.sql).all(...this.params) };
    }

    run() {
      const info = db.prepare(this.sql).run(...this.params);
      return {
        success: true,
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      };
    }
  }

  return {
    prepare(sql) {
      return new Statement(sql);
    },
    async batch(statements) {
      return statements.map((statement) => (/^\s*select/i.test(statement.sql) ? statement.all() : statement.run()));
    },
    /** 测试里直接查库用 */
    raw: db,
  };
}
