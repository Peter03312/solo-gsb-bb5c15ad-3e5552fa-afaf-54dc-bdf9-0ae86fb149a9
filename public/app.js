/* global G, MarkerValidate */
'use strict';

/* ================= 状态 ================= */
const App = {
  revision: null,
  locked: false,
  state: null,        // 已保存的服务器状态
  draft: null,        // 正在编辑的状态
  dirty: false,
  selectedId: null,
  conflictRefs: new Set(),
  conflictDefects: new Set(),
  dragging: null,     // {id, offX, offY}
  idSeq: 1,
  pollTimer: null
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

/* ================= API ================= */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

const loadLayout = async () => (await api('GET', '/api/layout')).data;
const saveLayout = (state, expectedRevision, operator) =>
  api('PUT', '/api/layout', { state, expectedRevision, operator });
const lockLayout = (expectedRevision, operator) =>
  api('POST', '/api/layout/lock', { expectedRevision, operator });

/* ================= 初始化 ================= */
async function init() {
  const layout = await loadLayout();
  applyServerLayout(layout, true);
  bindEvents();
  startPolling();
  renderAll();
}

function applyServerLayout(layout, resetDraft) {
  App.revision = layout.revision;
  App.locked = layout.locked;
  App.state = layout.state;
  if (resetDraft) {
    App.draft = G.clone(layout.state);
    App.dirty = false;
    App.selectedId = null;
  }
}

function markDirty() {
  App.dirty = true;
  renderHeader();
  renderPalette();
  renderLiveIssues();
  drawCanvas();
}

/* ================= 标签页 ================= */
function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 调色板事件委托
  $('#palette').addEventListener('click', (e) => {
    const item = e.target.closest('.palette-item');
    if (item && !item.classList.contains('disabled')) addPlacement(item.dataset.typeId);
  });

  $('#btnRotateCW').addEventListener('click', () => rotateSelected(1));
  $('#btnRotateCCW').addEventListener('click', () => rotateSelected(-1));
  $('#angleSelect').addEventListener('change', (e) => setAngleSelected(Number(e.target.value)));
  $('#btnDelete').addEventListener('click', deleteSelected);

  $('#btnSave').addEventListener('click', onSave);
  $('#btnReload').addEventListener('click', onReload);
  $('#btnLock').addEventListener('click', onLock);

  canvas.addEventListener('pointerdown', onCanvasDown);
  window.addEventListener('pointermove', onCanvasMove);
  window.addEventListener('pointerup', onCanvasUp);
  window.addEventListener('keydown', onKeyDown);

  $('#btnAddDefect').addEventListener('click', () => addDefectForm());
  $('#btnAddType').addEventListener('click', () => addTypeForm());
  $('#btnSaveSettings').addEventListener('click', onSaveSettings);

  $('#btnDownloadCsv').addEventListener('click', () => {
    window.location.href = '/api/cutlist.csv';
  });

  $('#modalClose').addEventListener('click', () => { $('#modal').style.display = 'none'; });
  $('#modalReload').addEventListener('click', async () => {
    $('#modal').style.display = 'none';
    await onReload();
  });
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'settings') renderSettings();
  if (name === 'cutlist') renderCutlist();
  if (name === 'marker') drawCanvas();
}

/* ================= 画布坐标变换 ================= */
function viewTransform() {
  const { width: W, height: H } = App.draft.fabric;
  const mx = 70, my = 50;
  const scale = Math.min((canvas.width - 2 * mx) / W, (canvas.height - 2 * my) / H);
  return {
    scale,
    ox: (canvas.width - W * scale) / 2,
    oy: (canvas.height - H * scale) / 2,
    toX: (wx) => (canvas.width - W * scale) / 2 + wx * scale,
    toY: (wy) => (canvas.height - H * scale) / 2 + wy * scale,
    toWX: (sx) => (sx - (canvas.width - W * scale) / 2) / scale,
    toWY: (sy) => (sy - (canvas.height - H * scale) / 2) / scale
  };
}

function actualRing(p) {
  const t = typeById(p.typeId);
  return G.transformPolygon(t.points, p.x, p.y, p.angle);
}

function typeById(id) {
  return App.draft.types.find((t) => String(t.id) === String(id));
}

function placementById(id) {
  return (App.draft.placements || []).find((p) => String(p.id) === String(id));
}

/* ================= 绘制 ================= */
function drawCanvas() {
  if (!App.draft) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { width: W, height: H } = App.draft.fabric;
  const vt = viewTransform();

  // 布面
  ctx.fillStyle = '#dcc49a';
  ctx.fillRect(vt.toX(0), vt.toY(0), W * vt.scale, H * vt.scale);

  // 网格（每 10cm）
  ctx.strokeStyle = 'rgba(120,90,40,.18)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#7a6436';
  ctx.font = '10px sans-serif';
  ctx.beginPath();
  for (let x = 0; x <= W + 1e-6; x += 10) {
    const sx = vt.toX(x);
    ctx.moveTo(sx, vt.toY(0)); ctx.lineTo(sx, vt.toY(H));
    if (x > 0 && x < W) ctx.fillText(`${x}`, sx - 6, vt.toY(H) + 16);
  }
  for (let y = 0; y <= H + 1e-6; y += 10) {
    const sy = vt.toY(y);
    ctx.moveTo(vt.toX(0), sy); ctx.lineTo(vt.toX(W), sy);
    if (y > 0 && y < H) ctx.fillText(`${y}`, vt.toX(0) - 34, sy + 3);
  }
  ctx.stroke();

  // 布边
  ctx.strokeStyle = '#8a5a2b';
  ctx.lineWidth = 2;
  ctx.strokeRect(vt.toX(0), vt.toY(0), W * vt.scale, H * vt.scale);

  // 缺陷（红色斜线填充）
  (App.draft.defects || []).forEach((d, di) => {
    const bad = App.conflictDefects.has(di);
    drawRing(d.points, '#d9534f', bad ? '#ff1100' : '#b02a26', bad ? 0.55 : 0.35, true);
    const c = centroid(d.points);
    ctx.fillStyle = '#7f1d1d';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(d.name || `缺陷${di + 1}`, vt.toX(c.x), vt.toY(c.y));
    ctx.textAlign = 'start';
  });

  // 裁片
  (App.draft.placements || []).forEach((p) => {
    const t = typeById(p.typeId);
    const ring = actualRing(p);
    const isSel = String(p.id) === String(App.selectedId);
    const isBad = App.conflictRefs.has(String(p.id));
    drawRing(
      ring,
      t.color || '#4f8ff7',
      isBad ? '#ff1100' : isSel ? '#0d3d91' : '#26303d',
      0.55,
      false,
      isSel ? 3 : isBad ? 3 : 1.5,
      isBad ? [6, 4] : null
    );
    // 定位点
    const c = centroid(ring);
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(vt.toX(p.x), vt.toY(p.y), 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#101418';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.name, vt.toX(c.x), vt.toY(c.y) - 4);
    if (isBad) {
      ctx.fillStyle = '#d10505';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('⚠', vt.toX(ring[0].x), vt.toY(ring[0].y) - 6);
    }
    ctx.textAlign = 'start';
  });

  if (App.locked) {
    ctx.fillStyle = 'rgba(185,28,28,.08)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function drawRing(worldRing, fill, stroke, alpha, hatch, lineWidth, dash) {
  const vt = viewTransform();
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  worldRing.forEach((p, i) => {
    const sx = vt.toX(p.x), sy = vt.toY(p.y);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.globalAlpha = 1;
  if (hatch) {
    ctx.clip();
    ctx.strokeStyle = 'rgba(120,10,10,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = -canvas.height; k < canvas.width; k += 8) {
      ctx.moveTo(k, 0);
      ctx.lineTo(k + canvas.height, canvas.height);
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  worldRing.forEach((p, i) => {
    const sx = vt.toX(p.x), sy = vt.toY(p.y);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth || 1.5;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  ctx.restore();
}

function centroid(ring) {
  let x = 0, y = 0;
  ring.forEach((p) => { x += p.x; y += p.y; });
  return { x: x / ring.length, y: y / ring.length };
}

/* ================= 鼠标交互 ================= */
function hitTest(wx, wy) {
  const list = App.draft.placements || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ring = actualRing(list[i]);
    if (G.pointInPoly({ x: wx, y: wy }, ring) !== 0) return list[i];
  }
  return null;
}

function onCanvasDown(e) {
  if (App.locked) return;
  const vt = viewTransform();
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
  const wx = vt.toWX(sx), wy = vt.toWY(sy);
  const hit = hitTest(wx, wy);
  App.selectedId = hit ? hit.id : null;
  if (hit) {
    App.dragging = { id: hit.id, offX: wx - hit.x, offY: wy - hit.y };
    canvas.setPointerCapture(e.pointerId);
  }
  renderSelectPanel();
  drawCanvas();
}

function onCanvasMove(e) {
  if (!App.dragging || App.locked) return;
  const vt = viewTransform();
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
  const p = placementById(App.dragging.id);
  if (!p) return;
  p.x = round1(vt.toWX(sx) - App.dragging.offX);
  p.y = round1(vt.toWY(sy) - App.dragging.offY);
  markDirty();
  renderSelectPanel();
}

function onCanvasUp() {
  App.dragging = null;
}

function onKeyDown(e) {
  if (!$('#tab-marker').classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === 'r' || e.key === 'R') rotateSelected(1);
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  if (e.key === 'Escape') { App.selectedId = null; renderSelectPanel(); drawCanvas(); }
}

/* ================= 裁片操作 ================= */
function addPlacement(typeId) {
  if (App.locked) return;
  const t = typeById(typeId);
  const used = (App.draft.placements || []).filter((p) => String(p.typeId) === String(typeId)).length;
  if (used >= t.quantity) return;
  const p = {
    id: `u${Date.now().toString(36)}${App.idSeq++}`,
    typeId: String(typeId),
    x: round1(App.draft.fabric.width / 2),
    y: round1(App.draft.fabric.height / 2),
    angle: G.normAngle(Number(t.allowedAngles[0]))
  };
  App.draft.placements = App.draft.placements || [];
  App.draft.placements.push(p);
  App.selectedId = p.id;
  markDirty();
  renderSelectPanel();
}

function rotateSelected(dir) {
  if (App.locked || App.selectedId == null) return;
  const p = placementById(App.selectedId);
  if (!p) return;
  const t = typeById(p.typeId);
  const angs = (t.allowedAngles || []).map((a) => G.normAngle(Number(a))).sort((a, b) => a - b);
  const cur = G.normAngle(p.angle);
  let next;
  if (dir > 0) next = angs.find((a) => a > cur + G.ANG_EPS) ?? angs[0];
  else next = [...angs].reverse().find((a) => a < cur - G.ANG_EPS) ?? angs[angs.length - 1];
  p.angle = G.normAngle(next);
  markDirty();
  renderSelectPanel();
}

function setAngleSelected(ang) {
  if (App.locked || App.selectedId == null) return;
  const p = placementById(App.selectedId);
  if (!p) return;
  p.angle = G.normAngle(ang);
  markDirty();
}

function deleteSelected() {
  if (App.locked || App.selectedId == null) return;
  App.draft.placements = App.draft.placements.filter((p) => String(p.id) !== String(App.selectedId));
  App.selectedId = null;
  markDirty();
  renderSelectPanel();
}

function round1(v) { return Math.round(v * 10) / 10; }

/* ================= 侧栏渲染 ================= */
function renderHeader() {
  $('#revBadge').textContent = `修订 #${App.revision}`;
  $('#lockBadge').style.display = App.locked ? '' : 'none';
  $('#dirtyBadge').style.display = App.dirty ? '' : 'none';
  const lockedBanner = document.getElementById('lockedBanner');
  if (App.locked && !lockedBanner) {
    const b = document.createElement('div');
    b.id = 'lockedBanner';
    b.className = 'locked-banner';
    b.textContent = '🔒 该版图已锁定，禁止任何改动；可在“裁切清单”页下载最终清单。';
    $('.sidebar').prepend(b);
  } else if (!App.locked && lockedBanner) {
    lockedBanner.remove();
  }
  $('#btnSave').disabled = App.locked || !App.dirty;
  $('#btnLock').disabled = App.locked;
  $('#btnAddDefect').disabled = App.locked;
  $('#btnAddType').disabled = App.locked;
  $('#btnSaveSettings').disabled = App.locked;
}

function renderPalette() {
  const counts = new Map();
  (App.draft.placements || []).forEach((p) =>
    counts.set(String(p.typeId), (counts.get(String(p.typeId)) || 0) + 1));
  $('#palette').innerHTML = '';
  App.draft.types.forEach((t) => {
    const n = counts.get(String(t.id)) || 0;
    const remain = t.quantity - n;
    const div = document.createElement('div');
    div.className = 'palette-item' + (remain <= 0 || App.locked ? ' disabled' : '');
    div.dataset.typeId = t.id;
    div.innerHTML = `
      <span class="dot" style="background:${t.color || '#4f8ff7'}"></span>
      <span class="meta">
        <div class="name">${escapeHtml(t.name)}</div>
        <div class="sub">需求 ${t.quantity} · 已排 ${n} · 剩余 ${Math.max(0, remain)} · 间距 ${t.spacing}cm · 角度 ${(t.allowedAngles || []).join('/')}°</div>
      </span>`;
    $('#palette').appendChild(div);
  });
  $('#fabricInfo').textContent =
    `${App.draft.fabric.width} cm × ${App.draft.fabric.height} cm；缺陷 ${(App.draft.defects || []).length} 处`;
}

function renderSelectPanel() {
  const panel = $('#selectPanel');
  const p = App.selectedId != null ? placementById(App.selectedId) : null;
  if (!p) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const t = typeById(p.typeId);
  $('#selectInfo').innerHTML =
    `款型：<b>${escapeHtml(t.name)}</b><br>定位点：(${round1(p.x)}, ${round1(p.y)}) cm<br>角度：${round1(G.normAngle(p.angle))}°`;
  const sel = $('#angleSelect');
  sel.innerHTML = '';
  (t.allowedAngles || []).forEach((a) => {
    const na = G.normAngle(Number(a));
    const opt = document.createElement('option');
    opt.value = na;
    opt.textContent = `${na}°`;
    if (G.angleMatches(p.angle, na)) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderLiveIssues() {
  const box = $('#liveIssues');
  App.conflictRefs = new Set();
  App.conflictDefects = new Set();
  if (App.locked) {
    box.innerHTML = '<div class="issue ok">版图已锁定。</div>';
    return;
  }
  const r = MarkerValidate.validateState(App.draft);
  const items = [];
  for (const e of r.errors) items.push({ cls: 'err', text: `✖ ${e.message}`, e });
  for (const c of r.conflicts) items.push({ cls: 'bad', text: `⚠ ${c.message}`, e: c });

  for (const it of items) {
    const e = it.e;
    if (e.placementId != null) App.conflictRefs.add(String(e.placementId));
    if (e.a) App.conflictRefs.add(String(e.a));
    if (e.b) App.conflictRefs.add(String(e.b));
    if (e.kind === 'defect' && e.defectId != null) App.conflictDefects.add(e.defectId);
  }

  if (!items.length) {
    box.innerHTML = '<div class="issue ok">✓ 实时核对通过：数量、布边、缺陷、间距均合格（保存时服务器再次校验）。</div>';
  } else {
    box.innerHTML = items.map((it) => `<div class="issue ${it.cls}">${escapeHtml(it.text)}</div>`).join('');
  }
}

/* ================= 保存 / 锁定 ================= */
async function onSave() {
  if (App.locked) return;
  setStatus('保存中…');
  const operator = $('#operator').value.trim();
  const r = await saveLayout(App.draft, App.revision, operator);
  if (r.status === 200) {
    applyServerLayout({
      revision: r.data.revision, locked: App.locked, state: r.data.state
    }, true);
    setStatus(`已保存为第 ${r.data.revision} 版 ✓`);
    renderAll();
  } else {
    handleRejected(r.data);
    setStatus('保存被拒绝');
  }
}

async function onReload() {
  const layout = await loadLayout();
  applyServerLayout(layout, true);
  setStatus(`已载入第 ${layout.revision} 版`);
  renderAll();
}

async function onLock() {
  if (App.locked) return;
  setStatus('校验并锁定中…');
  const operator = $('#operator').value.trim();

  // 先把未保存改动随锁定意图保存，再锁；若需严格“只锁已存稿”，可注释掉这两步
  if (App.dirty) {
    const sr = await saveLayout(App.draft, App.revision, operator);
    if (sr.status !== 200) {
      handleRejected(sr.data);
      setStatus('锁定中止：当前稿件未通过保存校验');
      return;
    }
    applyServerLayout({ revision: sr.data.revision, locked: false, state: sr.data.state }, true);
  }

  const r = await lockLayout(App.revision, operator);
  if (r.status === 200) {
    applyServerLayout({ revision: r.data.revision, locked: true, state: r.data.state }, true);
    setStatus(`已锁定为第 ${r.data.revision} 版 🔒`);
    renderAll();
  } else {
    handleRejected(r.data);
    setStatus('锁定被拒绝');
  }
}

function handleRejected(data) {
  // 服务器返回的冲突也标到画布上
  App.conflictRefs = new Set();
  App.conflictDefects = new Set();
  const all = [...(data.errors || []), ...(data.conflicts || [])];
  for (const e of all) {
    if (e.placementId != null) App.conflictRefs.add(String(e.placementId));
    if (e.a) App.conflictRefs.add(String(e.a));
    if (e.b) App.conflictRefs.add(String(e.b));
    if (e.kind === 'defect' && e.defectId != null) App.conflictDefects.add(e.defectId);
  }
  drawCanvas();

  const title =
    data.code === 'REVISION_CONFLICT' ? '修订号过期' :
    data.code === 'LOCKED' || data.code === 'ALREADY_LOCKED' ? '版图已锁定' :
    data.code === 'INVALID_STATE' ? '非法输入，整稿未改动' :
    '存在冲突，整张版图未改动';
  $('#modalTitle').textContent = title;
  $('#modalMsg').textContent = data.message || '';
  const parts = [];
  (data.errors || []).forEach((e) => parts.push(`<div class="issue err">✖ ${escapeHtml(e.message)}</div>`));
  (data.conflicts || []).forEach((c) => parts.push(`<div class="issue bad">⚠ ${escapeHtml(c.message)}</div>`));
  $('#modalBody').innerHTML = parts.join('');
  $('#modalReload').style.display =
    (data.code === 'REVISION_CONFLICT' || data.serverRevision != null) && data.serverRevision !== App.revision ? '' : 'none';
  $('#modal').style.display = 'flex';
}

function setStatus(s) {
  $('#saveStatus').textContent = s;
}

/* ================= 轮询他人修改 ================= */
function startPolling() {
  App.pollTimer = setInterval(async () => {
    try {
      const layout = await loadLayout();
      if (layout.revision !== App.revision) {
        if (!App.dirty) {
          applyServerLayout(layout, true);
          setStatus(`检测到他人新版本，已自动载入第 ${layout.revision} 版`);
          renderAll();
        } else {
          setStatus(`⚠ 他人已提交第 ${layout.revision} 版（你在改 #${App.revision}）；请先载入新稿，否则保存将被拒绝`);
        }
      }
    } catch (e) { /* 忽略瞬时轮询失败 */ }
  }, 5000);
}

/* ================= 设置页 ================= */
function renderSettings() {
  $('#setW').value = App.draft.fabric.width;
  $('#setH').value = App.draft.fabric.height;
  $('#defectList').innerHTML = '';
  (App.draft.defects || []).forEach((d, i) => addDefectForm(d, i));
  $('#typeList').innerHTML = '';
  App.draft.types.forEach((t) => addTypeForm(t));
}

function pointsToText(points) {
  return points.map((p) => `${p.x},${p.y}`).join('\n');
}

function addDefectForm(d, idx) {
  const use = d || { name: `缺陷${(idx != null ? idx : (App.draft.defects || []).length) + 1}`,
    points: [{ x: 40, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 50 }, { x: 40, y: 50 }] };
  const card = document.createElement('div');
  card.className = 'entity-card defect-card';
  card.innerHTML = `
    <div class="card-head">
      <input class="f-name" value="${escapeAttr(use.name || '缺陷')}" placeholder="缺陷名称" ${App.locked ? 'disabled' : ''}/>
      <button class="btn btn-danger f-del" ${App.locked ? 'disabled' : ''}>删除</button>
    </div>
    <textarea class="points f-points" ${App.locked ? 'disabled' : ''}
      placeholder="每行 x,y">${escapeHtml(pointsToText(use.points))}</textarea>`;
  card.querySelector('.f-del').addEventListener('click', () => card.remove());
  $('#defectList').appendChild(card);
}

function addTypeForm(t) {
  const use = t || {
    id: `t${Date.now().toString(36)}`,
    name: `新款型 ${App.draft.types.length + 1}`,
    points: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
    quantity: 1, allowedAngles: [0], spacing: 1, color: pickColor(App.draft.types.length)
  };
  const card = document.createElement('div');
  card.className = 'entity-card type-card';
  card.dataset.id = use.id;
  card.innerHTML = `
    <div class="card-head">
      <input class="f-name" value="${escapeAttr(use.name)}" placeholder="款型名称" ${App.locked ? 'disabled' : ''}/>
      <input type="color" class="f-color color-input" value="${use.color || '#4f8ff7'}" ${App.locked ? 'disabled' : ''}/>
      <button class="btn btn-danger f-del" ${App.locked ? 'disabled' : ''}>删除</button>
    </div>
    <div class="entity-grid">
      <label>所需数量（正整数）<input type="number" class="f-qty" min="1" step="1" value="${use.quantity}" ${App.locked ? 'disabled' : ''}/></label>
      <label>安全间距 cm（≥0）<input type="number" class="f-spacing" min="0" step="0.1" value="${use.spacing}" ${App.locked ? 'disabled' : ''}/></label>
      <label>允许角度（逗号分隔）<input type="text" class="f-angles" value="${use.allowedAngles.join(',')}" ${App.locked ? 'disabled' : ''}/></label>
    </div>
    <p class="hint">裁片多边形（局部坐标，每行 x,y；不得自交）</p>
    <textarea class="points f-points" ${App.locked ? 'disabled' : ''}>${escapeHtml(pointsToText(use.points))}</textarea>`;
  card.querySelector('.f-del').addEventListener('click', () => card.remove());
  $('#typeList').appendChild(card);
}

function parsePoints(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    const parts = line.split(/[,，;；\s]+/).filter(Boolean);
    if (parts.length !== 2) {
      return { error: `无法解析点「${line}」，应为 x,y` };
    }
    const x = Number(parts[0]), y = Number(parts[1]);
    if (!G.isNum(x) || !G.isNum(y)) return { error: `点「${line}」坐标必须为有限数值` };
    out.push({ x, y });
  }
  return { points: out };
}

function onSaveSettings() {
  if (App.locked) return;
  const problems = [];

  const W = Number($('#setW').value);
  const H = Number($('#setH').value);
  if (!G.isNum(W) || W <= 0) problems.push('布幅宽度必须为正数');
  if (!G.isNum(H) || H <= 0) problems.push('布幅高度必须为正数');

  const defects = [];
  $$('#defectList .defect-card').forEach((card, i) => {
    const parsed = parsePoints(card.querySelector('.f-points').value);
    if (parsed.error) { problems.push(`缺陷 ${i + 1}：${parsed.error}`); return; }
    const chk = G.checkSimplePolygon(parsed.points);
    if (!chk.ok) { problems.push(`缺陷「${card.querySelector('.f-name').value || i + 1}」：${chk.reason}`); return; }
    defects.push({ name: card.querySelector('.f-name').value.trim() || `缺陷${i + 1}`, points: chk.poly });
  });

  const types = [];
  const usedIds = new Set();
  $$('#typeList .type-card').forEach((card, i) => {
    const name = card.querySelector('.f-name').value.trim() || `款型${i + 1}`;
    const parsed = parsePoints(card.querySelector('.f-points').value);
    if (parsed.error) { problems.push(`款型「${name}」：${parsed.error}`); return; }
    const chk = G.checkSimplePolygon(parsed.points);
    if (!chk.ok) { problems.push(`款型「${name}」：${chk.reason}`); return; }

    const qty = Number(card.querySelector('.f-qty').value);
    if (!G.isNum(qty) || qty <= 0 || Math.abs(qty - Math.round(qty)) > 1e-9) {
      problems.push(`款型「${name}」：所需数量必须为正整数`);
    }
    const spacing = Number(card.querySelector('.f-spacing').value);
    if (!G.isNum(spacing) || spacing < 0) problems.push(`款型「${name}」：安全间距必须为非负数`);

    const angleParts = card.querySelector('.f-angles').value.split(/[,，\s]+/).filter(Boolean);
    const angles = [];
    if (!angleParts.length) {
      problems.push(`款型「${name}」：至少给一个允许角度`);
    }
    for (const a0 of angleParts) {
      const a = Number(a0);
      if (!G.isNum(a)) { problems.push(`款型「${name}」：非法角度「${a0}」`); continue; }
      const na = G.normAngle(a);
      if (!angles.some((x) => G.angleMatches(x, na))) angles.push(na);
    }

    let id = card.dataset.id;
    if (!id || usedIds.has(id)) id = `t${Date.now().toString(36)}${i}`;
    usedIds.add(id);
    types.push({
      id, name, points: chk.poly,
      quantity: Math.round(qty),
      allowedAngles: angles,
      spacing,
      color: card.querySelector('.f-color').value
    });
  });

  if (problems.length) {
    alert('基础设置有以下问题，未应用：\n\n• ' + problems.join('\n• '));
    return;
  }

  // 去掉引用已删款型的摆放
  const validIds = new Set(types.map((t) => t.id));
  App.draft.fabric = { width: W, height: H };
  App.draft.defects = defects;
  App.draft.types = types;
  App.draft.placements = (App.draft.placements || []).filter((p) => validIds.has(String(p.typeId)));
  App.selectedId = null;
  markDirty();
  alert('基础设置已应用到本地草稿（尚未保存到服务器）。请到“排版画布”页保存版图。');
  switchTab('marker');
}

const PALETTE_COLORS = ['#4f8ff7', '#f79646', '#34a853', '#a06cd5', '#e05297', '#0f9d8f', '#d97706'];
function pickColor(i) { return PALETTE_COLORS[i % PALETTE_COLORS.length]; }

/* ================= 裁切清单页 ================= */
function renderCutlist() {
  // 以服务器已保存稿件为准
  const s = App.state;
  const tbody = $('#placedTable tbody');
  tbody.innerHTML = '';
  let seq = 0;
  (s.types || []).forEach((t) => {
    const placed = (s.placements || []).filter((p) => String(p.typeId) === String(t.id));
    placed.forEach((p) => {
      seq += 1;
      const ring = G.transformPolygon(t.points, Number(p.x), Number(p.y), Number(p.angle));
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${seq}</td><td>${escapeHtml(t.name)}</td><td>${round3(p.x)}</td><td>${round3(p.y)}</td>` +
        `<td>${round3(G.normAngle(Number(p.angle)))}°</td>` +
        `<td class="muted">${ring.map((q) => `(${round3(q.x)}, ${round3(q.y)})`).join(' ')}</td>`;
      tbody.appendChild(tr);
    });
  });
  if (!seq) tbody.innerHTML = '<tr><td colspan="6" class="muted">尚无已保存的摆放裁片。</td></tr>';

  const counts = new Map();
  (s.placements || []).forEach((p) => counts.set(String(p.typeId), (counts.get(String(p.typeId)) || 0) + 1));
  const sb = $('#summaryTable tbody');
  sb.innerHTML = '';
  (s.types || []).forEach((t) => {
    const placed = counts.get(String(t.id)) || 0;
    const unplaced = Math.max(0, t.quantity - placed);
    const tr = document.createElement('tr');
    if (unplaced > 0) tr.className = 'unplaced';
    tr.innerHTML = `<td>${escapeHtml(t.name)}</td><td>${t.quantity}</td><td>${placed}</td><td>${unplaced}</td>`;
    sb.appendChild(tr);
  });
}

function round3(v) { return Math.round(Number(v) * 1000) / 1000; }

/* ================= 杂项 ================= */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }

function renderAll() {
  renderHeader();
  renderPalette();
  renderSelectPanel();
  renderLiveIssues();
  drawCanvas();
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:20px;color:#b91c1c">初始化失败：${escapeHtml(e.message)}</div>`);
});
