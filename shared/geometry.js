/**
 * geometry.js — 前后端共用的 2D 多边形几何内核
 *
 * 坐标系：屏幕/布面坐标系，x 向右、y 向下；角度为度，逆时针为正。
 * 旋转只用标准旋转矩阵（det = +1），永远不做镜像翻转。
 *
 * @typedef {{x:number,y:number}} Pt
 * @typedef {Pt[]} Ring
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9; // 距离判定容差（单位 cm），“恰等允许”即 absGap >= req - EPS
  const ANG_EPS = 1e-6; // 角度判定容差（度）

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function isPt(v) {
    return !!v && isNum(v.x) && isNum(v.y);
  }

  /** 去掉首尾重复闭合点，返回新数组；点数不足返回 null */
  function cleanRing(poly) {
    if (!Array.isArray(poly)) return null;
    const pts = poly.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
    if (pts.length >= 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS) pts.pop();
    }
    return pts.length >= 3 ? pts : null;
  }

  /** 两倍有向面积：>0 逆时针(CCW)，<0 顺时针(CW)，==0 退化 */
  function signedArea2(poly) {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s;
  }

  function pointSegDist(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const l2 = vx * vx + vy * vy;
    if (l2 <= EPS * EPS) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * vx + (py - ay) * vy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  }

  /**
   * 线段 AB 与 CD 的关系
   * @returns {{rel:'none'|'cross'|'overlap'|'touch', t:number}}
   *   cross   内部横穿（跨立，两边严格异侧）
   *   overlap 共线且有长度重叠
   *   touch   端点落在另一线段内部 / T 接 / 端点相接（面积重叠不含此类）
   *   t       最小距离（cross/overlap 时为 0）
   */
  function segRelation(ax, ay, bx, by, cx, cy, dx, dy) {
    const rx = bx - ax, ry = by - ay;
    const sx = dx - cx, sy = dy - cy;
    const rxs = rx * sy - ry * sx;
    const qpx = cx - ax, qpy = cy - ay;
    const qpxr = qpx * ry - qpy * rx;
    const tol = EPS * (1 + Math.hypot(rx, ry) + Math.hypot(sx, sy));

    if (Math.abs(rxs) <= tol) {
      // 平行
      if (Math.abs(qpxr) > tol) return { rel: 'none', t: Infinity };
      // 共线：投影到 r 方向，判断区间重叠
      const r2 = rx * rx + ry * ry;
      if (r2 <= EPS * EPS) {
        // AB 退化为点
        const d = pointSegDist(ax, ay, cx, cy, dx, dy);
        return d <= EPS ? { rel: 'touch', t: 0 } : { rel: 'none', t: d };
      }
      const t0 = 0;
      const t1 = 1;
      const tc = ((cx - ax) * rx + (cy - ay) * ry) / r2;
      const td = ((dx - ax) * rx + (dy - ay) * ry) / r2;
      const lo = Math.max(t0, Math.min(tc, td));
      const hi = Math.min(t1, Math.max(tc, td));
      if (hi < lo - EPS) {
        // 不重叠，返回端点到另一线段的最短距离
        const d = Math.min(
          pointSegDist(ax, ay, cx, cy, dx, dy),
          pointSegDist(bx, by, cx, cy, dx, dy),
          pointSegDist(cx, cy, ax, ay, bx, by),
          pointSegDist(dx, dy, ax, ay, bx, by)
        );
        return { rel: 'none', t: d };
      }
      if (hi - lo <= EPS) return { rel: 'touch', t: 0 }; // 仅端点相接
      return { rel: 'overlap', t: 0 };
    }

    const t = qpxr / rxs;
    const u = (qpx * sy - qpy * sx) / rxs;
    if (t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS) {
      return { rel: 'cross', t: 0 };
    }
    if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
      // 相交但至少一个交点是端点
      const onEnd =
        Math.abs(t) <= EPS || Math.abs(t - 1) <= EPS ||
        Math.abs(u) <= EPS || Math.abs(u - 1) <= EPS;
      return { rel: onEnd ? 'touch' : 'cross', t: 0 };
    }
    // 不相交：计算端点到另一线段的最短距离
    const d = Math.min(
      pointSegDist(ax, ay, cx, cy, dx, dy),
      pointSegDist(bx, by, cx, cy, dx, dy),
      pointSegDist(cx, cy, ax, ay, bx, by),
      pointSegDist(dx, dy, ax, ay, bx, by)
    );
    return { rel: 'none', t: d };
  }

  /** 逐对顶点去重（含相邻重合/零长度边） */
  function hasDuplicatePoints(poly) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(poly[i].x - poly[j].x) <= EPS &&
            Math.abs(poly[i].y - poly[j].y) <= EPS) return true;
      }
    }
    return false;
  }

  /**
   * 自交/退化检测
   * @returns {{ok:true}|{ok:false,reason:string}}
   */
  function checkSimplePolygon(input) {
    const poly = cleanRing(input);
    if (!poly) return { ok: false, reason: '多边形至少需要 3 个不重合顶点' };
    for (const p of poly) {
      if (!isNum(p.x) || !isNum(p.y)) return { ok: false, reason: '多边形顶点坐标必须为有限数值' };
    }
    if (hasDuplicatePoints(poly)) return { ok: false, reason: '多边形存在重合顶点或零长度边' };

    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        const c = poly[j], d = poly[(j + 1) % n];
        const adjacent =
          j === i + 1 ||
          (i === 0 && j === n - 1);
        const r = segRelation(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
        if (adjacent) {
          if (r.rel === 'overlap') {
            return { ok: false, reason: '相邻边共线重叠，多边形非法' };
          }
        } else if (r.rel !== 'none') {
          return { ok: false, reason: '非相邻边相交，多边形自交' };
        }
      }
    }
    if (Math.abs(signedArea2(poly)) <= EPS) return { ok: false, reason: '多边形面积为零（退化）' };
    return { ok: true, poly };
  }

  /** 把多边形绕原点旋转 angleDeg 再平移 (tx,ty)，不做镜像 */
  function transformPolygon(poly, tx, ty, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    return poly.map((p) => ({
      x: p.x * c - p.y * s + tx,
      y: p.x * s + p.y * c + ty
    }));
  }

  /** 点是否在多边形内部或边界上 */
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (pointSegDist(p.x, p.y, a.x, a.y, b.x, b.y) <= EPS) return 2; // 边界
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside ? 1 : 0;
  }

  function edgeInwardSide(poly, i, mid) {
    // 不依赖环绕方向：两侧各探一点，返回指向 poly 内部的那一侧单位向量
    const n = poly.length;
    const a = poly[i], b = poly[(i + 1) % n];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const p1 = { x: mid.x + nx * 1e-6, y: mid.y + ny * 1e-6 };
    const p2 = { x: mid.x - nx * 1e-6, y: mid.y - ny * 1e-6 };
    if (pointInPoly(p1, poly) === 1) return { x: nx, y: ny };
    if (pointInPoly(p2, poly) === 1) return { x: -nx, y: -ny };
    return null;
  }

  /**
   * 两个简单多边形之间的最小间隙（cm），以及是否存在“面积级重叠”
   * @returns {{gap:number, overlap:boolean}}
   *   overlap=true：内部横穿、边中点入内，或共线边重叠且两侧内部相通
   *   仅端点接触、T 接不算面积重叠，此时 gap=0
   */
  function polygonsDistance(A, B) {
    let minD = Infinity;
    let overlap = false;

    // 顶点落在对方内部 => 面积重叠
    for (const p of A) {
      if (pointInPoly(p, B) === 1) overlap = true;
    }
    if (!overlap) {
      for (const p of B) {
        if (pointInPoly(p, A) === 1) { overlap = true; break; }
      }
    }

    // 边中点落在对方内部（含退化：两矩形沿边界方向错开重叠时无顶点入内）
    if (!overlap) {
      for (let i = 0; i < A.length && !overlap; i++) {
        const m = { x: (A[i].x + A[(i + 1) % A.length].x) / 2,
                    y: (A[i].y + A[(i + 1) % A.length].y) / 2 };
        if (pointInPoly(m, B) === 1) overlap = true;
      }
      for (let j = 0; j < B.length && !overlap; j++) {
        const m = { x: (B[j].x + B[(j + 1) % B.length].x) / 2,
                    y: (B[j].y + B[(j + 1) % B.length].y) / 2 };
        if (pointInPoly(m, A) === 1) overlap = true;
      }
    }

    for (let i = 0; i < A.length; i++) {
      const a = A[i], b = A[(i + 1) % A.length];
      for (let j = 0; j < B.length; j++) {
        const c = B[j], d = B[(j + 1) % B.length];
        const r = segRelation(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
        if (r.rel === 'cross') overlap = true;
        if (r.rel === 'overlap') {
          // 共线重叠：沿 A 边指向 A 内部的方向微动，若同时进入 B 内部 => 共享面积
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const inA = edgeInwardSide(A, i, mid);
          if (inA) {
            const pin = { x: mid.x + inA.x * 1e-6, y: mid.y + inA.y * 1e-6 };
            if (pointInPoly(pin, B) === 1) overlap = true;
          }
          minD = 0;
        } else if (r.rel === 'touch') {
          minD = 0;
        } else if (r.t < minD) {
          minD = r.t;
        }
      }
    }
    if (overlap) minD = 0;
    return { gap: minD, overlap };
  }

  /** 归一化到 [0,360) */
  function normAngle(a) {
    let r = a % 360;
    if (r < 0) r += 360;
    return r;
  }

  /** 实际角度是否等于某个允许角度（支持 0/360 等价） */
  function angleMatches(actual, allowed) {
    let diff = Math.abs(normAngle(actual) - normAngle(allowed)) % 360;
    if (diff > 180) diff = 360 - diff;
    return diff <= ANG_EPS;
  }

  /** 多边形包围盒 */
  function bbox(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  /** 深拷贝状态（仅 JSON 数据） */
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  return {
    EPS, ANG_EPS,
    isNum, isPt, cleanRing, signedArea2,
    pointSegDist, segRelation, hasDuplicatePoints,
    checkSimplePolygon, transformPolygon, pointInPoly,
    polygonsDistance, normAngle, angleMatches, bbox, clone
  };
});
