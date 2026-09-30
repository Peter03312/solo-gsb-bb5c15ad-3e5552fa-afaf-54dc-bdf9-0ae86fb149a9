/**
 * db.js — SQLite 持久化
 *
 * 单活动版图模型：layout 单行（id=1）保存最新整稿，revisions 留修订流水。
 * 保存必须携带所见修订号 expected_revision（乐观锁），过期则拒绝，不覆盖新稿。
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { validateState } = require('./validate');
const { defaultState } = require('./seed');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS layout (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      revision      INTEGER NOT NULL,
      locked        INTEGER NOT NULL DEFAULT 0,
      state_json    TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      revision      INTEGER NOT NULL,
      action        TEXT NOT NULL,
      state_json    TEXT NOT NULL,
      operator      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const row = db.prepare('SELECT revision FROM layout WHERE id = 1').get();
  if (!row) {
    const state = defaultState();
    db.prepare('INSERT INTO layout (id, revision, locked, state_json) VALUES (1, 1, 0, ?)')
      .run(JSON.stringify(state));
    db.prepare('INSERT INTO revisions (revision, action, state_json, operator) VALUES (1, ?, ?, ?)')
      .run('init', JSON.stringify(state), 'system');
  }
  return db;
}

function getLayout() {
  const row = db.prepare('SELECT revision, locked, state_json, updated_at FROM layout WHERE id = 1').get();
  return {
    revision: row.revision,
    locked: !!row.locked,
    updatedAt: row.updated_at,
    state: JSON.parse(row.state_json)
  };
}

/**
 * 保存整稿（校验 + 乐观锁 + 事务，任一不合格整张版图不变）
 * @returns {{ok:true,revision:number,state:object}|{ok:false,status:number,code:string,message:string,errors?:array,conflicts?:array,serverRevision?:number,locked?:boolean}}
 */
function saveLayout({ state, expectedRevision, operator, action }) {
  const cur = db.prepare('SELECT revision, locked, state_json FROM layout WHERE id = 1').get();
  if (cur.locked) {
    return { ok: false, status: 423, code: 'LOCKED', message: '版图已锁定，禁止任何改动', serverRevision: cur.revision, locked: true };
  }
  if (!Number.isInteger(expectedRevision)) {
    return { ok: false, status: 400, code: 'BAD_REVISION', message: '必须携带所见版图修订号（expectedRevision 为整数）' };
  }
  if (expectedRevision !== cur.revision) {
    return {
      ok: false, status: 409, code: 'REVISION_CONFLICT',
      message: `修订号过期：你基于第 ${expectedRevision} 版修改，服务器已是第 ${cur.revision} 版，请载入新稿后再提交`,
      serverRevision: cur.revision
    };
  }

  const result = validateState(state);
  if (!result.ok) {
    // 明确非法输入（自交多边形、非正尺寸、非法角度等）用 422
    const status = result.errors.length ? 422 : 409;
    return {
      ok: false, status,
      code: result.errors.length ? 'INVALID_STATE' : 'LAYOUT_CONFLICT',
      message: result.errors.length
        ? '存在非法输入，整张版图未改动'
        : '存在排版冲突，整张版图未改动',
      errors: result.errors,
      conflicts: result.conflicts,
      serverRevision: cur.revision
    };
  }

  const nextRev = cur.revision + 1;
  const json = JSON.stringify(normalizeState(state));
  const tx = db.transaction(() => {
    db.prepare('UPDATE layout SET revision = ?, state_json = ?, updated_at = datetime(\'now\') WHERE id = 1')
      .run(nextRev, json);
    db.prepare('INSERT INTO revisions (revision, action, state_json, operator) VALUES (?, ?, ?, ?)')
      .run(nextRev, action || 'save', json, operator || null);
  });
  tx();

  return { ok: true, revision: nextRev, state: JSON.parse(json) };
}

/**
 * 锁定：再次校验当前稿件，合法才锁定。锁定后 saveLayout 一律拒绝。
 */
function lockLayout({ expectedRevision, operator }) {
  const cur = db.prepare('SELECT revision, locked, state_json FROM layout WHERE id = 1').get();
  if (cur.locked) {
    return { ok: false, status: 423, code: 'ALREADY_LOCKED', message: '版图已经处于锁定状态', serverRevision: cur.revision, locked: true };
  }
  if (!Number.isInteger(expectedRevision)) {
    return { ok: false, status: 400, code: 'BAD_REVISION', message: '必须携带所见版图修订号（expectedRevision 为整数）' };
  }
  if (expectedRevision !== cur.revision) {
    return {
      ok: false, status: 409, code: 'REVISION_CONFLICT',
      message: `修订号过期：你基于第 ${expectedRevision} 版，服务器已是第 ${cur.revision} 版，请刷新后再锁定`,
      serverRevision: cur.revision
    };
  }
  const state = JSON.parse(cur.state_json);
  const result = validateState(state);
  if (!result.ok) {
    const status = result.errors.length ? 422 : 409;
    return {
      ok: false, status,
      code: result.errors.length ? 'INVALID_STATE' : 'LAYOUT_CONFLICT',
      message: result.errors.length ? '当前稿件含非法输入，不能锁定' : '当前稿件仍有排版冲突，不能锁定',
      errors: result.errors,
      conflicts: result.conflicts,
      serverRevision: cur.revision
    };
  }
  const nextRev = cur.revision + 1;
  const tx = db.transaction(() => {
    db.prepare('UPDATE layout SET revision = ?, locked = 1, updated_at = datetime(\'now\') WHERE id = 1')
      .run(nextRev);
    db.prepare('INSERT INTO revisions (revision, action, state_json, operator) VALUES (?, ?, ?, ?)')
      .run(nextRev, 'lock', cur.state_json, operator || null);
  });
  tx();
  return { ok: true, revision: nextRev, locked: true, state };
}

function listRevisions(limit = 50) {
  return db.prepare('SELECT revision, action, operator, created_at FROM revisions ORDER BY id DESC LIMIT ?')
    .all(limit);
}

/** 去掉客户端可能携带的多余字段，保持存储结构稳定 */
function normalizeState(s) {
  return {
    fabric: { width: Number(s.fabric.width), height: Number(s.fabric.height) },
    defects: (s.defects || []).map((d, i) => ({
      name: d.name != null && String(d.name).trim() ? String(d.name) : `缺陷${i + 1}`,
      points: d.points.map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    })),
    types: s.types.map((t) => ({
      id: String(t.id),
      name: String(t.name),
      points: t.points.map((p) => ({ x: Number(p.x), y: Number(p.y) })),
      quantity: Math.round(Number(t.quantity)),
      allowedAngles: t.allowedAngles.map((a) => Number(a)),
      spacing: Number(t.spacing),
      color: t.color || null
    })),
    placements: (s.placements || []).map((p) => ({
      id: p.id != null ? String(p.id) : undefined,
      typeId: String(p.typeId),
      x: Number(p.x),
      y: Number(p.y),
      angle: Number(p.angle)
    })).map((p) => (p.id === undefined ? { typeId: p.typeId, x: p.x, y: p.y, angle: p.angle } : p))
  };
}

module.exports = { init, getLayout, saveLayout, lockLayout, listRevisions };
