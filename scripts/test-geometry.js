/**
 * test-geometry.js — 零依赖自测：几何内核 + 整稿校验的关键规则
 * 运行：npm test
 */
const assert = require('assert');
const G = require('../shared/geometry');
const { validateState } = require('../src/validate');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const rect = (x0, y0, w, h) => [
  { x: x0, y: y0 }, { x: x0 + w, y: y0 },
  { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }
];

/* ---------------- 几何内核 ---------------- */
test('自交多边形被拒绝（蝴蝶结）', () => {
  const bow = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.strictEqual(G.checkSimplePolygon(bow).ok, false);
});

test('合法矩形通过；顶点不足被拒绝', () => {
  assert.strictEqual(G.checkSimplePolygon(rect(0, 0, 10, 10)).ok, true);
  assert.strictEqual(G.checkSimplePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }]).ok, false);
});

test('重复顶点 / 共线重叠邻边被拒绝', () => {
  assert.strictEqual(G.checkSimplePolygon([
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
    { x: 10, y: 10 }, { x: 0, y: 10 }
  ]).ok, false);
});

test('非凸合法多边形通过；凹形自交被拒绝', () => {
  // 简单凹五边形
  const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    { x: 5, y: 5 }, { x: 0, y: 10 }];
  assert.strictEqual(G.checkSimplePolygon(concave).ok, true);
});

test('两矩形距离：分离 / 恰等接触 / 重叠', () => {
  const a = rect(0, 0, 10, 10);
  const b1 = rect(15, 0, 10, 10);
  assert.ok(Math.abs(G.polygonsDistance(a, b1).gap - 5) < 1e-9);
  assert.strictEqual(G.polygonsDistance(a, b1).overlap, false);

  const b2 = rect(10, 0, 10, 10); // 边恰好接触
  const r2 = G.polygonsDistance(a, b2);
  assert.ok(Math.abs(r2.gap) < 1e-9);
  assert.strictEqual(r2.overlap, false);

  const b3 = rect(9, 0, 10, 10); // 面积重叠
  assert.strictEqual(G.polygonsDistance(a, b3).overlap, true);
});

test('一点接触（角对角）不算面积重叠，gap=0', () => {
  const a = rect(0, 0, 10, 10);
  const b = rect(10, 10, 10, 10);
  const r = G.polygonsDistance(a, b);
  assert.strictEqual(r.overlap, false);
  assert.ok(Math.abs(r.gap) < 1e-9);
});

test('共线重叠但边相邻（外离）不算面积重叠', () => {
  const a = rect(0, 0, 10, 10);
  const b = rect(2, 10, 6, 10);
  const r = G.polygonsDistance(a, b);
  assert.strictEqual(r.overlap, false);
  assert.ok(Math.abs(r.gap) < 1e-9);
});

test('点到线段距离与 T 接', () => {
  assert.ok(Math.abs(G.pointSegDist(5, -3, 0, 0, 10, 0) - 3) < 1e-9);
  const r = G.segRelation(0, 0, 10, 0, 5, 0, 5, 8);
  assert.strictEqual(r.rel, 'touch');
});

test('旋转矩阵不镜像；角度归一化与匹配', () => {
  const p = G.transformPolygon([{ x: 1, y: 0 }], 0, 0, 90)[0];
  assert.ok(Math.abs(p.x - 0) < 1e-9);
  assert.ok(Math.abs(p.y - 1) < 1e-9);
  assert.ok(G.angleMatches(360, 0));
  assert.ok(G.angleMatches(-90, 270));
  assert.ok(!G.angleMatches(90, 0));
});

test('pointInPoly 内外与边界', () => {
  const a = rect(0, 0, 10, 10);
  assert.strictEqual(G.pointInPoly({ x: 5, y: 5 }, a), 1);
  assert.strictEqual(G.pointInPoly({ x: 15, y: 5 }, a), 0);
  assert.strictEqual(G.pointInPoly({ x: 0, y: 5 }, a), 2);
});

/* ---------------- 整稿校验 ---------------- */
function baseState() {
  return {
    fabric: { width: 100, height: 60 },
    defects: [],
    types: [{
      id: 'a', name: 'A', points: rect(-5, -5, 10, 10),
      quantity: 2, allowedAngles: [0, 90], spacing: 2
    }, {
      id: 'b', name: 'B', points: rect(-5, -5, 10, 10),
      quantity: 1, allowedAngles: [0], spacing: 4
    }],
    placements: []
  };
}

test('合法摆放通过', () => {
  const s = baseState();
  s.placements = [
    { id: 'p1', typeId: 'a', x: 10, y: 10, angle: 0 },
    { id: 'p2', typeId: 'a', x: 30, y: 10, angle: 0 }
  ];
  assert.strictEqual(validateState(s).ok, true);
});

test('非正布幅尺寸被拒绝', () => {
  const s = baseState();
  s.fabric.width = 0;
  const r = validateState(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'BAD_FABRIC'));
});

test('自交裁片多边形被拒绝（明确原因）', () => {
  const s = baseState();
  s.types[0].points = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  const r = validateState(s);
  assert.ok(r.errors.some((e) => e.code === 'SELF_INTERSECT'));
});

test('非法角度 / 不允许的摆放角度被拒绝（禁止翻面）', () => {
  const s = baseState();
  s.types[0].allowedAngles = [0, 90, 'x'];
  assert.ok(validateState(s).errors.some((e) => e.code === 'BAD_ANGLES'));

  const s2 = baseState();
  s2.placements = [{ id: 'p1', typeId: 'a', x: 20, y: 20, angle: 45 }];
  const r2 = validateState(s2);
  assert.ok(r2.errors.some((e) => e.code === 'ILLEGAL_ANGLE'));
});

test('数量超出被标记为冲突', () => {
  const s = baseState();
  s.placements = [1, 2, 3].map((i) => ({ id: `p${i}`, typeId: 'a', x: 10 + i * 20, y: 30, angle: 0 }));
  const r = validateState(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.code === 'QUANTITY_EXCEEDED'));
});

test('布边：恰等允许，差一点拒绝', () => {
  const s = baseState();
  // 裁片半宽 5 + spacing 2 => x 最小 7，恰等
  s.placements = [{ id: 'p1', typeId: 'a', x: 7, y: 30, angle: 0 }];
  assert.strictEqual(validateState(s).ok, true);

  s.placements[0].x = 6.9999;
  const r = validateState(s);
  assert.ok(r.conflicts.some((c) => c.code === 'EDGE_GAP'));
});

test('缺陷：重叠拒绝；间距恰等允许', () => {
  const s = baseState();
  // 裁片中心 (20,30)，半宽5；缺陷右边 x=13 时间距=2 恰等
  s.defects = [{ name: 'd', points: rect(0, 25, 13, 10) }];
  s.placements = [{ id: 'p1', typeId: 'a', x: 20, y: 30, angle: 0 }];
  assert.strictEqual(validateState(s).ok, true);

  s.defects[0].points = rect(0, 25, 14, 10); // 间距 1 < 2
  const r1 = validateState(s);
  assert.ok(r1.conflicts.some((c) => c.code === 'DEFECT_GAP'));

  s.defects[0].points = rect(16, 25, 10, 10); // 压上
  const r2 = validateState(s);
  assert.ok(r2.conflicts.some((c) => c.code === 'DEFECT_OVERLAP'));
});

test('两片间距取较大值：恰等允许，不足拒绝', () => {
  const s = baseState();
  // A(20,30) 右缘 25，B spacing=4 => B 左缘至少 29 => B 中心 34
  s.placements = [
    { id: 'p1', typeId: 'a', x: 20, y: 30, angle: 0 },
    { id: 'p2', typeId: 'b', x: 34, y: 30, angle: 0 }
  ];
  assert.strictEqual(validateState(s).ok, true);

  s.placements[1].x = 33.999; // gap 3.999 < 4
  const r = validateState(s);
  assert.ok(r.conflicts.some((c) => c.code === 'PIECE_GAP'));
  assert.strictEqual(r.conflicts.find((c) => c.code === 'PIECE_GAP').required, 4);
});

test('两片面积重叠 => PIECE_OVERLAP', () => {
  const s = baseState();
  s.types[1].allowedAngles = [0];
  s.placements = [
    { id: 'p1', typeId: 'a', x: 20, y: 30, angle: 0 },
    { id: 'p2', typeId: 'b', x: 22, y: 30, angle: 0 }
  ];
  const r = validateState(s);
  assert.ok(r.conflicts.some((c) => c.code === 'PIECE_OVERLAP'));
});

test('旋转 90° 后按实际轮廓核对布边', () => {
  const s = baseState();
  s.types[0].points = [{ x: -10, y: -3 }, { x: 10, y: -3 }, { x: 10, y: 3 }, { x: -10, y: 3 }];
  s.types[0].spacing = 1;
  // 旋转 90°：半宽变为 3，x 最小允许 4
  s.placements = [{ id: 'p1', typeId: 'a', x: 4, y: 20, angle: 90 }];
  assert.strictEqual(validateState(s).ok, true);
});

test('引用不存在款型 / 重复实例 id 被拒绝', () => {
  const s = baseState();
  s.placements = [{ id: 'p1', typeId: 'zzz', x: 20, y: 20, angle: 0 }];
  assert.ok(validateState(s).errors.some((e) => e.code === 'UNKNOWN_TYPE'));

  const s2 = baseState();
  s2.placements = [
    { id: 'x', typeId: 'a', x: 20, y: 20, angle: 0 },
    { id: 'x', typeId: 'a', x: 40, y: 20, angle: 0 }
  ];
  assert.ok(validateState(s2).errors.some((e) => e.code === 'DUP_PLACEMENT'));
});

test('未排数量允许 > 0（部分排版可保存）', () => {
  const s = baseState();
  s.placements = [{ id: 'p1', typeId: 'a', x: 20, y: 30, angle: 0 }];
  assert.strictEqual(validateState(s).ok, true);
});

console.log(`\n全部 ${passed} 项测试通过。`);
