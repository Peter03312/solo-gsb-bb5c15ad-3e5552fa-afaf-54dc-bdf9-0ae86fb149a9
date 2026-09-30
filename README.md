# 服装打样裁片排版系统

在浏览器画布上完成服装打样的**裁片排版（marker making）**：录入布幅尺寸、布面缺陷多边形和各款裁片多边形，
操作者把裁片摆放到布面上（只能在允许角度内旋转，**不能翻面**），保存时服务器按**旋转平移后的实际轮廓**
核对数量、布边距离、缺陷避让和裁片间距；任一不合格则**整张版图保持不变**，并标出全部冲突对象与原因。
多人协作通过**修订号乐观锁**防止过期提交覆盖新稿；锁定后禁止一切改动，并可导出裁切清单。

- 后端：Node.js + Express + SQLite（better-sqlite3，同步事务）
- 前端：原生 HTML5 Canvas，无需构建
- 几何内核：前后端共用同一份 `shared/geometry.js` + `src/validate.js`，规则零分歧
- 单位：厘米（cm），角度：度（°）

---

## 一、一键启动（Docker，推荐）

需要本机已安装 Docker 与 Docker Compose v2。

```bash
docker compose up --build -d
```

镜像构建时会自动安装依赖；容器**首次启动自动初始化数据库**（建表并写入示例布幅/缺陷/款型）。
数据保存在命名卷 `marker-data` 中，容器重建不丢稿。

停止 / 查看日志：

```bash
docker compose down
docker compose logs -f
```

> 预编译二进制默认从国内镜像 `registry.npmmirror.com` 下载。可直连 GitHub 时，
> 编辑 `docker-compose.yml` 中 build args，把 `NPM_BETTER_SQLITE3_BINARY_HOST` 置空即可。

## 二、本机直接运行（Node.js >= 20）

```bash
# 方式 A：脚本（装依赖 + 初始化 + 启动）
bash scripts/start.sh

# 方式 B：手动
npm install
npm start
```

首次启动自动在 `data/marker.db` 建库建表并写入示例数据；删除该文件可恢复出厂示例。

---

## 三、访问地址与端口

| 项目 | 地址 |
| --- | --- |
| 排版页面 | <http://localhost:3000/> |
| 当前版图（JSON） | <http://localhost:3000/api/layout> |
| 裁切清单（CSV 下载） | <http://localhost:3000/api/cutlist.csv> |
| 修订流水 | <http://localhost:3000/api/revisions> |

端口被占用时：

- Docker：改 `docker-compose.yml` 里 `"3000:3000"` 的左侧宿主机端口。
- 本机：`PORT=8080 npm start`。

---

## 四、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/marker.db` | SQLite 数据库文件路径 |
| `NPM_CONFIG_BETTER_SQLITE3_BINARY_HOST` | `https://registry.npmmirror.com/-/binary/better-sqlite3` | better-sqlite3 预编译二进制镜像（安装期生效） |

---

## 五、操作说明

页面分三个标签：

1. **排版画布**
   - 左侧款型面板点击“加入布面”，布面上拖动定位；选中后可旋转（按钮 / 角度下拉 / R 键）、移出（Delete）。
   - 旋转角只能取该款型的「允许角度」（纯旋转矩阵，永远不镜像翻面）。
   - 画布实时用与服务器相同的规则预检，冲突裁片/缺陷红框高亮并列出原因。
   - 顶部显示当前**修订号**、**锁定状态**、是否有未保存改动；页面每 5 秒轮询新版本。
   - **保存版图**：携带所见修订号提交。**校验并锁定**：当前稿件通过校验后锁定。
2. **基础设置**：布幅宽/高、缺陷多边形（每行 `x,y`）、各款裁片多边形/所需数量/允许角度/安全间距/颜色。
   保存设置只是更新本地草稿，需回到画布页再“保存版图”。
3. **裁切清单**：列出每片位置、角度、旋转后实际轮廓、未排数量，可下载 CSV。

---

## 六、校验规则（保存/锁定时服务器强制执行）

- **非法输入直接拒绝（422，整稿不变）**
  - 自交/退化多边形、重合顶点、共线重叠邻边；
  - 布幅宽高非正数；数量非正整数；安全间距为负；允许角度含非数值或为空；
  - 摆放角度不在允许角度集合内、引用不存在款型、实例 id 重复、缺陷超出布幅等。
- **排版冲突拒绝落库（409，整稿不变，返回全部冲突对象及原因）**
  - **数量**：每款摆放数不得超过所需数量（未排数量允许大于 0，可分批保存）；
  - **布边**：裁片（旋转后实际轮廓的每个顶点）距左/右/上/下布边 ≥ 该款自身安全间距；
  - **缺陷**：裁片距任一缺陷 ≥ 该款自身安全间距，且任何重叠（含仅压线时 spacing=0 允许恰好接触）均禁止；
  - **裁片之间**：两片间隙 ≥ 两款安全间距的**较大值**；面积重叠一律禁止。
  - 所有间距比较**恰好相等视为合格**（容差 1e-9 cm）。
- **修订号乐观锁**
  - 每次保存/锁定必须带 `expectedRevision`；与服务器当前修订不一致时返回 `409 REVISION_CONFLICT`，不覆盖新稿，
    前端弹层可一键“载入服务器新稿”。
  - 成功保存修订号 +1；锁定操作修订号 +1 并置锁定标志。
- **锁定后**：一切写操作返回 `423 LOCKED`，界面禁用编辑，仅可查看与下载清单。

## 七、HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/layout` | 当前整稿：`{revision, locked, state, summary}` |
| PUT | `/api/layout` | body：`{expectedRevision, operator, state}`；失败原样返回冲突明细，不写库 |
| POST | `/api/layout/lock` | body：`{expectedRevision, operator}`；再校验后锁定 |
| GET | `/api/revisions` | 最近 50 条修订流水 |
| GET | `/api/cutlist.csv` | 下载 `cutlist-rev<n>.csv`（含未排行与数量汇总） |

## 八、自测

```bash
npm test
```

覆盖 22 项：自交检测、间隙/接触/重叠、角度匹配、布边恰等、缺陷避让、两片取大间距、旋转后轮廓、
数量超限、乐观锁冲突等关键规则。

## 九、目录结构

```
shared/geometry.js     前后端共用几何内核（自交检测、旋转、点在多边形内、间隙/重叠）
src/validate.js        整稿校验（数量/布边/缺陷/间距），UMD，浏览器直接复用
src/db.js              SQLite：建库、乐观锁事务保存、锁定、修订流水
src/server.js          Express API、CSV 裁切清单、静态资源
src/seed.js            首次启动示例数据
public/                Canvas 前端（index.html / app.js / styles.css）
scripts/test-geometry.js  零依赖自测
Dockerfile / docker-compose.yml  一键构建启动
```
