# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,photo}.ts
        ├── stores/{specimen,procedure,supply}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,CompareView}.tsx
        └── utils/{db,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段，勾选在库批次联动扣减库存，序号跳号报错，不足整单不写 | PrepProcedure、Specimen、SupplyLot |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、手工领用登记、批次领用明细（关联工序/用量/操作人/退回状态） | SupplyLot |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 四张表：`specimens`（标本）、`procedures`（修复工序，含 `materialUsages` 领用快照）、`supplies`（工具材料批次 + 领用记录，领用记录含 `status`/关联工序字段）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：工序补齐 `materialUsages`，历史领用记录补 `status='issued'`；在库数量与历史记录原样保留，老档案升级后可直接继续使用。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、3 个工序节点（含 1 个已回退示例）、4 个材料批次与 2 张留痕影像，便于直接查看。

## 功能要点

- **工序-材料批次联动**：新建工序时按工序类型（清修→磨料/耗材，加固/粘接/翻模→胶种/耗材，补配→磨料/胶种/耗材）勾选一个或多个在库批次并填用量；保存工序与扣减批次在同一个 IndexedDB 事务内完成，保存后在库数量立即扣减。
- **库存不足整单不写入**：任一选用批次数量不足（同一批次重复填写会先汇总）则整个事务回滚，工序不落库、其他批次也不会被扣，页面逐批指出「哪一批、需多少、在库多少」。
- **批次明细可追溯**：批次行「明细」可展开全部领用记录，含关联工序（#序号/类型/节点名）、用量、操作人、用于标本、领用时间；手工领用标注「台账手工领用」。
- **回退自动退库**：回退工序节点时同事务把用量退回原批次，原领用记录保留并标记为「已退回」（含退回时间），重复回退不会重复加库存。
- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。
