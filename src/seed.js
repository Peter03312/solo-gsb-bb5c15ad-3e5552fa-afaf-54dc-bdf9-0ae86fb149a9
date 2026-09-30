/**
 * seed.js — 首次启动的示例数据（单位 cm，角度单位度）
 * 操作者可在「设置」页任意修改/删除这些款型与缺陷。
 */
function defaultState() {
  return {
    fabric: { width: 150, height: 100 },
    defects: [
      {
        name: '破洞A',
        points: [
          { x: 95, y: 20 },
          { x: 112, y: 16 },
          { x: 118, y: 28 },
          { x: 108, y: 40 },
          { x: 96, y: 36 }
        ]
      }
    ],
    types: [
      {
        id: 'front',
        name: '前片',
        // 裁片多边形以自身定位点（旋转中心）为原点的局部坐标
        points: [
          { x: -12, y: -20 },
          { x: 12, y: -20 },
          { x: 14, y: 8 },
          { x: 6, y: 20 },
          { x: -6, y: 20 },
          { x: -14, y: 8 }
        ],
        quantity: 2,
        allowedAngles: [0, 180],
        spacing: 1,
        color: '#4f8ff7'
      },
      {
        id: 'sleeve',
        name: '袖片',
        points: [
          { x: -8, y: -18 },
          { x: 8, y: -14 },
          { x: 10, y: 14 },
          { x: -10, y: 18 }
        ],
        quantity: 2,
        allowedAngles: [0, 90, 180, 270],
        spacing: 1.5,
        color: '#f79646'
      }
    ],
    placements: []
  };
}

module.exports = { defaultState };
