/**
 * server.js — HTTP 服务
 *   GET  /                       编辑器页面
 *   GET  /api/layout             读取当前整稿（含修订号、锁定标志）
 *   PUT  /api/layout             携带 expectedRevision 保存（校验不过整张不变）
 *   POST /api/layout/lock        携带 expectedRevision 锁定
 *   GET  /api/revisions          修订流水
 *   GET  /api/cutlist.csv        下载裁切清单（CSV）
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const dbMod = require('./db');
const G = require('../shared/geometry');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'marker.db');
const ROOT = path.join(__dirname, '..');

const app = express();
app.use(express.json({ limit: '5mb' }));

dbMod.init(DB_PATH);

/* ---------------- 工具 ---------------- */

function summarize(state) {
  const counts = new Map();
  for (const p of state.placements || []) {
    counts.set(String(p.typeId), (counts.get(String(p.typeId)) || 0) + 1);
  }
  return (state.types || []).map((t) => {
    const placed = counts.get(String(t.id)) || 0;
    return {
      typeId: String(t.id),
      name: t.name,
      required: t.quantity,
      placed,
      unplaced: Math.max(0, t.quantity - placed)
    };
  });
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCutlist(layout) {
  const { revision, locked, state } = layout;
  const rows = [];
  rows.push(['# 服装裁片裁切清单']);
  rows.push(['# 修订号', revision]);
  rows.push(['# 状态', locked ? '已锁定' : '编辑中']);
  rows.push(['# 布幅宽(cm)', state.fabric.width]);
  rows.push(['# 布幅高(cm)', state.fabric.height]);
  rows.push(['# 生成时间', new Date().toISOString()]);
  rows.push([]);
  rows.push(['序号', '款型', '状态', '定位X(cm)', '定位Y(cm)', '角度(°)',
    '旋转后实际轮廓 X;Y;…(cm)', '安全间距(cm)', '允许角度(°)']);

  const byType = new Map();
  for (const p of state.placements || []) {
    const id = String(p.typeId);
    if (!byType.has(id)) byType.set(id, []);
    byType.get(id).push(p);
  }

  let seq = 0;
  for (const t of state.types || []) {
    const placed = byType.get(String(t.id)) || [];
    placed.forEach((p) => {
      seq += 1;
      const ring = G.transformPolygon(t.points, Number(p.x), Number(p.y), Number(p.angle));
      rows.push([
        seq, t.name, '已排', round3(p.x), round3(p.y), round3(G.normAngle(Number(p.angle))),
        ring.map((q) => `${round3(q.x)};${round3(q.y)}`).join(' '),
        t.spacing,
        (t.allowedAngles || []).join('/')
      ]);
    });
    const unplaced = Math.max(0, t.quantity - placed.length);
    for (let k = 0; k < unplaced; k++) {
      seq += 1;
      rows.push([seq, t.name, '未排', '', '', '', '', t.spacing, (t.allowedAngles || []).join('/')]);
    }
  }

  rows.push([]);
  rows.push(['# 汇总']);
  rows.push(['款型', '需求', '已排', '未排']);
  for (const s of summarize(state)) {
    rows.push([s.name, s.required, s.placed, s.unplaced]);
  }

  return '﻿' + rows
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n');
}

function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

/* ---------------- API ---------------- */

app.get('/api/layout', (req, res) => {
  const layout = dbMod.getLayout();
  res.json({ ...layout, summary: summarize(layout.state) });
});

app.put('/api/layout', (req, res) => {
  const { state, expectedRevision, operator } = req.body || {};
  const result = dbMod.saveLayout({
    state,
    expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : Number(expectedRevision),
    operator,
    action: 'save'
  });
  if (!result.ok) {
    return res.status(result.status).json(result);
  }
  const layout = dbMod.getLayout();
  res.json({ ok: true, revision: result.revision, state: result.state, summary: summarize(result.state),
    updatedAt: layout.updatedAt });
});

app.post('/api/layout/lock', (req, res) => {
  const { expectedRevision, operator } = req.body || {};
  const result = dbMod.lockLayout({
    expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : Number(expectedRevision),
    operator
  });
  if (!result.ok) return res.status(result.status).json(result);
  const layout = dbMod.getLayout();
  res.json({ ok: true, revision: result.revision, locked: true, state: result.state,
    summary: summarize(result.state), updatedAt: layout.updatedAt });
});

app.get('/api/revisions', (req, res) => {
  res.json({ revisions: dbMod.listRevisions(50) });
});

app.get('/api/cutlist.csv', (req, res) => {
  const layout = dbMod.getLayout();
  const csv = buildCutlist(layout);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="cutlist-rev${layout.revision}.csv"`);
  res.send(csv);
});

/* ---------------- 静态资源 ---------------- */
app.get('/shared/geometry.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(ROOT, 'shared', 'geometry.js'));
});
app.get('/src/validate.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(ROOT, 'src', 'validate.js'));
});
app.use(express.static(path.join(ROOT, 'public')));

// 兜底错误处理（校验模块抛出的意外异常等）
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, code: 'BAD_JSON', message: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  console.log(`裁片排版系统已启动: http://localhost:${PORT}`);
  console.log(`数据库: ${DB_PATH}`);
});
