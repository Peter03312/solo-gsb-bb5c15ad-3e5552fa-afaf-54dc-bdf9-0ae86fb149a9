/**
 * validate.js — 版图状态的完整校验
 *
 * 输入为客户端提交的整张版图状态（布幅、缺陷、裁片款型、摆放实例）。
 * 任一规则不合格：返回全部冲突 { ok:false, errors:[], conflicts:[] }，
 * 调用方保证“整张版图不变”（数据库写入在事务中，校验不过即不提交）。
 *
 * 间距规则（恰等允许，容差 EPS）：
 *   - 裁片距布边 >= 该款安全间距
 *   - 裁片距任一缺陷 >= 该款安全间距
 *   - 两片间距 >= max(款A间距, 款B间距)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/geometry'));
  } else {
    root.MarkerValidate = factory(root.G);
  }
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  function err(code, message, extra) {
  return Object.assign({ code, message }, extra || {});
}

/**
 * @param {object} state
 * @returns {{ok:true, prepared:Array}|{ok:false,errors:Array,conflicts:Array}}
 *   prepared: 校验通过后的实际轮廓等中间结果，供调用方复用
 */
function validateState(state) {
  const errors = [];
  const conflicts = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, errors: [err('BAD_STATE', '版图状态必须是对象')], conflicts: [] };
  }

  /* ---------------- 布幅 ---------------- */
  const fabric = state.fabric;
  if (!fabric || typeof fabric !== 'object') {
    return { ok: false, errors: [err('BAD_FABRIC', '缺少布幅定义')], conflicts: [] };
  }
  const W = Number(fabric.width);
  const H = Number(fabric.height);
  if (!G.isNum(W) || W <= 0) {
    errors.push(err('BAD_FABRIC', '布幅宽度必须为正数（cm）', { field: 'fabric.width' }));
  }
  if (!G.isNum(H) || H <= 0) {
    errors.push(err('BAD_FABRIC', '布幅高度必须为正数（cm）', { field: 'fabric.height' }));
  }
  const fabricOK = errors.length === 0;

  /* ---------------- 缺陷多边形 ---------------- */
  const defects = [];
  if (state.defects !== undefined && state.defects !== null) {
    if (!Array.isArray(state.defects)) {
      errors.push(err('BAD_DEFECTS', '缺陷列表必须是数组'));
    } else {
      state.defects.forEach((d, di) => {
        const where = `defects[${di}]`;
        if (!d || !Array.isArray(d.points)) {
          errors.push(err('BAD_DEFECT', `缺陷 ${di + 1}：points 必须是顶点数组`, { where }));
          return;
        }
        const chk = G.checkSimplePolygon(d.points);
        if (!chk.ok) {
          errors.push(err('SELF_INTERSECT', `缺陷 ${di + 1}：${chk.reason}（自交/非法多边形一律拒绝）`, { where }));
          return;
        }
        const ring = chk.poly;
        let out = null;
        if (fabricOK) {
          for (const p of ring) {
            if (p.x < -G.EPS || p.y < -G.EPS || p.x > W + G.EPS || p.y > H + G.EPS) {
              out = p; break;
            }
          }
          if (out) {
            errors.push(err('DEFECT_OUTSIDE',
              `缺陷 ${di + 1}：顶点 (${round(out.x)}, ${round(out.y)}) 超出布幅 ${round(W)}×${round(H)}`,
              { where, point: out }));
            return;
          }
        }
        defects.push({ id: di, name: d.name ? String(d.name) : `缺陷${di + 1}`, ring });
      });
    }
  }

  /* ---------------- 裁片款型 ---------------- */
  const types = new Map();
  if (!Array.isArray(state.types)) {
    errors.push(err('BAD_TYPES', '裁片款型列表必须是数组'));
  } else {
    const seenIds = new Set();
    state.types.forEach((t, ti) => {
      const where = `types[${ti}]`;
      if (!t || typeof t !== 'object') {
        errors.push(err('BAD_TYPE', `款型 ${ti + 1}：必须是对象`, { where }));
        return;
      }
      const id = String(t.id == null ? `t${ti}` : t.id);
      if (seenIds.has(id)) {
        errors.push(err('DUP_TYPE', `款型 id 重复：${id}`, { where, typeId: id }));
        return;
      }
      seenIds.add(id);

      const name = String(t.name || id);
      const chk = G.checkSimplePolygon(t.points);
      if (!chk.ok) {
        errors.push(err('SELF_INTERSECT', `款型「${name}」：${chk.reason}（自交多边形一律拒绝）`,
          { where, typeId: id }));
        return;
      }

      const qty = Number(t.quantity);
      if (!G.isNum(qty) || qty <= 0 || Math.abs(qty - Math.round(qty)) > G.EPS) {
        errors.push(err('BAD_QTY', `款型「${name}」：所需数量必须为正整数`, { where, typeId: id }));
      }

      const spacing = Number(t.spacing);
      if (!G.isNum(spacing) || spacing < 0) {
        errors.push(err('BAD_SPACING', `款型「${name}」：安全间距必须为非负数`, { where, typeId: id }));
      }

      let angles = t.allowedAngles;
      if (!Array.isArray(angles) || angles.length === 0) {
        errors.push(err('BAD_ANGLES', `款型「${name}」：允许旋转角度必须是非空数组（如 [0,90]）`,
          { where, typeId: id }));
        angles = [];
      }
      const normed = [];
      for (const a0 of angles) {
        const a = Number(a0);
        if (!G.isNum(a)) {
          errors.push(err('BAD_ANGLES', `款型「${name}」：存在非法角度值（必须为有限数值，单位度）`,
            { where, typeId: id }));
          continue;
        }
        const na = G.normAngle(a);
        if (!normed.some((x) => G.angleMatches(x, na))) normed.push(na);
      }

      if (!errors.some((e) => e.typeId === id)) {
        types.set(id, {
          id, name, local: chk.poly,
          quantity: Math.round(qty),
          spacing,
          angles: normed,
          color: t.color || null
        });
      }
    });
  }

  /* ---------------- 摆放实例 ---------------- */
  const placements = [];
  if (state.placements !== undefined && state.placements !== null) {
    if (!Array.isArray(state.placements)) {
      errors.push(err('BAD_PLACEMENTS', '摆放列表必须是数组'));
    } else {
      const seenIds = new Set();
      state.placements.forEach((p, pi) => {
        const where = `placements[${pi}]`;
        const ref = p && p.id != null ? String(p.id) : `#${pi + 1}`;
        if (!p || typeof p !== 'object') {
          errors.push(err('BAD_PLACEMENT', `裁片 ${ref}：必须是对象`, { where, placementId: ref }));
          return;
        }
        if (p.id != null) {
          if (seenIds.has(ref)) {
            errors.push(err('DUP_PLACEMENT', `裁片实例 id 重复：${ref}`, { where, placementId: ref }));
            return;
          }
          seenIds.add(ref);
        }
        const typeId = String(p.typeId);
        const type = types.get(typeId);
        if (!type) {
          errors.push(err('UNKNOWN_TYPE', `裁片 ${ref}：引用了不存在的款型「${typeId}」`,
            { where, placementId: ref, typeId }));
          return;
        }
        const x = Number(p.x), y = Number(p.y), a = Number(p.angle);
        if (!G.isNum(x) || !G.isNum(y)) {
          errors.push(err('BAD_POS', `裁片「${type.name}」${ref}：位置坐标必须为有限数值`,
            { where, placementId: ref, typeId }));
          return;
        }
        if (!G.isNum(a)) {
          errors.push(err('BAD_ANGLE', `裁片「${type.name}」${ref}：旋转角度必须为有限数值（度）`,
            { where, placementId: ref, typeId }));
          return;
        }
        if (!type.angles.some((al) => G.angleMatches(a, al))) {
          errors.push(err('ILLEGAL_ANGLE',
            `裁片「${type.name}」${ref}：角度 ${round(G.normAngle(a))}° 不在允许角度 ` +
            `${type.angles.map((v) => round(v)).join('、')}° 内；禁止翻面`,
            { where, placementId: ref, typeId, actual: G.normAngle(a), allowed: type.angles }));
          return;
        }
        placements.push({
          ref, type, x, y, angle: G.normAngle(a),
          ring: G.transformPolygon(type.local, x, y, a)
        });
      });
    }
  }

  // 数量核对：超出所需数量即冲突（未排数量允许大于 0，可分多次保存）
  const counts = new Map();
  for (const p of placements) counts.set(p.type.id, (counts.get(p.type.id) || 0) + 1);
  for (const t of types.values()) {
    const n = counts.get(t.id) || 0;
    if (n > t.quantity) {
      conflicts.push(err('QUANTITY_EXCEEDED',
        `款型「${t.name}」摆放 ${n} 片，超过所需数量 ${t.quantity}`,
        { typeId: t.id, placed: n, required: t.quantity }));
    }
  }

  // 几何核对需要布幅合法
  if (fabricOK) {
    /* ---- 布边：所有顶点必须落在内缩 spacing 的矩形内（恰等允许） ---- */
    for (const p of placements) {
      const r = p.type.spacing;
      for (const v of p.ring) {
        const checks = [
          ['左边', v.x, r],
          ['右边', W - v.x, r],
          ['下边', v.y, r],
          ['上边', H - v.y, r]
        ];
        for (const [side, d, req] of checks) {
          if (d + G.EPS < req) {
            conflicts.push(err('EDGE_GAP',
              `裁片「${p.type.name}」${p.ref} 距${side} ${round(d)} cm，` +
              `小于自身安全间距 ${round(req)} cm`,
              { kind: 'edge', placementId: p.ref, typeId: p.type.id, side, gap: d, required: req }));
          }
        }
      }
    }

    /* ---- 缺陷：间距 >= 自身 spacing；重叠一律不允许 ---- */
    for (const p of placements) {
      for (const d of defects) {
        const { gap, overlap } = G.polygonsDistance(p.ring, d.ring);
        const req = p.type.spacing;
        if (overlap) {
          conflicts.push(err('DEFECT_OVERLAP',
            `裁片「${p.type.name}」${p.ref} 与${d.name}区域重叠（缺陷不可压）`,
            { kind: 'defect', placementId: p.ref, defectId: d.id, defectName: d.name, gap: 0, required: req }));
        } else if (gap + G.EPS < req) {
          conflicts.push(err('DEFECT_GAP',
            `裁片「${p.type.name}」${p.ref} 距${d.name} ${round(gap)} cm，` +
            `小于自身安全间距 ${round(req)} cm`,
            { kind: 'defect', placementId: p.ref, defectId: d.id, defectName: d.name, gap, required: req }));
        }
      }
    }

    /* ---- 两两裁片：间距 >= max(s1,s2)；面积重叠一律不允许 ---- */
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const A = placements[i], B = placements[j];
        const { gap, overlap } = G.polygonsDistance(A.ring, B.ring);
        const req = Math.max(A.type.spacing, B.type.spacing);
        const label = `「${A.type.name}」${A.ref} 与「${B.type.name}」${B.ref}`;
        if (overlap) {
          conflicts.push(err('PIECE_OVERLAP', `${label} 轮廓重叠（裁片不得互相压叠）`, {
            kind: 'pair', a: A.ref, b: B.ref, typeA: A.type.id, typeB: B.type.id,
            gap: 0, required: req
          }));
        } else if (gap + G.EPS < req) {
          conflicts.push(err('PIECE_GAP',
            `${label}间距 ${round(gap)} cm，小于两者安全间距较大值 ${round(req)} cm`, {
              kind: 'pair', a: A.ref, b: B.ref, typeA: A.type.id, typeB: B.type.id,
              gap, required: req
            }));
        }
      }
    }
  }

  if (errors.length || conflicts.length) {
    return { ok: false, errors, conflicts, prepared: placements };
  }
  return { ok: true, prepared: placements, defects, types, W, H };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

return { validateState };
});
