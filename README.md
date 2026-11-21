---
title: 小满美图（img.fangkelianmeng.com）
owner: Michaelxlm
updated: 2026-11-04
scope: main-img
status: 有效
tags: [main-img, 静态站]
---

# 小满美图（img.fangkelianmeng.com）

高清壁纸图片精选站，汇聚海量精美壁纸，支持搜索、分类浏览与热门排行。

## 技术栈

- **零依赖纯静态站**：HTML + CSS + Vanilla JS，无框架、无构建工具
- **三层 CSS 架构**：`tokens.css`（设计令牌）→ `main.css`（站点基础）→ `gallery.css`（画廊专用）
- **模块化 JS**：`tracker.js`（埋点 SDK）→ `app.js`（主题/菜单）→ `gallery.js`（画廊交互）
- **API 数据源**：`/api/v1/front/antucao/image/` 系列接口（sample / rank / search / detail）
- **缩略图提速**：列表缩略图/灯箱展示图/详情页大图走 OSS `x-oss-process` 裁剪（w_400/w_1920，WebP 兜底 + AVIF `<picture>` 派生），下载仍用原图；卡片 `<img>` 带真实 `width`/`height` 属性防 CLS；失效时回退原图→外链→上报
- **图片域名**：`img.fangkelianmeng.com`
- **PWA**：Service Worker 离线兜底
- **SEO**：结构化数据 JSON-LD、Open Graph、sitemap.xml

## 目录结构

```
main-img/
├── assets/
│   ├── css/
│   │   ├── tokens.css      # 共享设计令牌
│   │   ├── main.css         # 站点主样式
│   │   └── gallery.css      # 图片画廊专用样式
│   ├── img/
│   │   ├── favicon.svg      # SVG 图标
│   │   └── og-cover.svg     # OG 封面图
│   └── js/
│       ├── tracker.js       # 统一埋点 SDK
│       ├── app.js           # 站点交互（主题/菜单/回到顶部/PWA）
│       ├── gallery.js       # 图片画廊交互核心
│       └── detail-set.js    # 详情精选集清单（build.js 产出，供灯箱「查看详情」判定，不盖 ?v= 保持常新）
├── data/
│   ├── categories.json      # 分类定义（slug 以中台字典 imageType 实据为准，现 21 类）
│   ├── type-registry.json   # 分类码登记表（build.js 自动维护，防抽样波动抖动）
│   └── index-observation.json  # 收录观测台账（与 sitemap 一一对应）
├── scripts/
│   ├── build.js             # 构建：精选集预渲染（分类落地页 + 详情精选页）+ 重写 sitemap + 台账同步 + 盖 ?v=
│   └── index-observation.js # 线上可访问性 + 收录观测核对（回写台账）
├── deploy/
│   └── nginx.conf           # Nginx 配置参考
├── index.html               # 首页（搜索 + 精选壁纸）
├── browse.html              # 全部图片（分页 + 排序）
├── rank.html                # 热门排行（Top 序号角标）
├── category.html            # 分类浏览（卡片入口，链向 /category/*.html 落地页）
├── favorites.html           # 我的收藏（纯本地，noindex 不入 sitemap）
├── about.html               # 关于与免责
├── 404.html                 # 404 页面
├── sw.js                    # Service Worker
├── robots.txt               # 搜索引擎爬虫规则
├── sitemap.xml              # 站点地图（主页面 + 分类落地页 + 详情精选页）
├── manifest.webmanifest     # PWA 清单
└── .gitignore
```

## 页面说明

| 页面 | 文件 | 说明 |
|------|------|------|
| 首页 | `index.html` | Hero 搜索 + 全部分类 chip + 可折叠高级筛选面板（类别/设备尺寸分辨率/宽高比/主色调数据门控/重置）+ 随机一张 + 瀑布流精选壁纸（滚动自动加载）；WO-155 首屏 12 张静态卡在 `<!--SSG:GRID-->` 内 |
| 全部图片 | `browse.html` | 可折叠高级筛选面板 + 随机一张 + 分页浏览 + 多排序方式，展示总张数；同 WO-155 首屏预渲染 |
| 热门排行 | `rank.html` | 按下载/点赞/浏览排序，卡片带名次角标（前 3 名金银铜）；同 WO-155 首屏预渲染 |
| 分类 | `category.html` | 分类卡片入口（链向落地页；`data/categories.json` 定义 chip，构建另覆盖 `type-registry.json` 历史分类码） |
| 分类落地页 | `category/{slug}.html` | 构建期预渲染（每类首屏 40 张静态卡 + SEO 文案），`build.js` 生成、勿手改；WO-155 正常扩容后 23 页 |
| 详情精选页 | `p/{id}.html` | 构建期预渲染（大图/元信息/下载/同类推荐/ImageObject，目标 300 / 硬上限 400），`build.js` 生成、勿手改 |
| 我的收藏 | `favorites.html` | 浏览本地收藏，支持取消/清空（noindex，不进 sitemap） |
| 关于 | `about.html` | 数据来源、版权声明、FAQ |
| 404 | `404.html` | 页面走丢了 |

灯箱预览能力：第 n/共 N 计数、收藏（与卡片双向同步）、左右键/触屏滑动切换、相邻大图预加载、热度数据展示；打开灯箱会补报一次浏览、下载时补报一次下载计数（供热度排序积累真实数据）；命中详情精选集（`detail-set.js` 的 `window.GM_DETAIL_IDS`）时展示「查看详情 →」链向 `/p/{id}.html`。

## 构建（精选集预渲染）

```bash
node scripts/build.js
```

拉取中台 sample/rank 接口（**WO-155 正常扩容**：每类按 `sort=download` 追加拉取 6 页，候选池 `PER_CATEGORY_FETCH=200`）→ 枚举真实分类码（`data/type-registry.json` 累计登记防抽样抖动）→ 按质量分级（有 title 优先，desc/tag 加分）去重选品，取满 `DETAIL_TARGET=300`（受 `DETAIL_LIMIT=400` 硬上限约束）→ 生成 `category/*.html`（每类首屏 40 张）与 `p/*.html`（仅预渲染精选集，全量 22 万在库图仍运行时取数）→ **WO-155：从精选集取 12 张静态卡注入 `index.html`/`browse.html`/`rank.html` 的 `<!--SSG:GRID-->`（运行时 `gallery.js` 仍清空容器取数；无 JS 爬虫看到非空首屏）** → 重写 `sitemap.xml`（主页面 + 全部生成页）与 `image-sitemap.xml` → 同步收录台账 → CSS/JS 盖 `?v=` 令牌（`detail-set.js` 故意不盖、保持常新）→ **产物门禁：列表页静态卡 ≥12 且全部指向在册详情页、类目页首屏非空，不过即中断构建（CI 阻断部署）**。

API 请求带有限重试 + 退避；网关抖动导致部分/整体失败时，沿用仓库上次的 sitemap 与已生成页、只增不删，不再把已收录 URL 抹掉。生成页为产物，需随仓库 commit（CI 部署前仍会重跑构建）。可抓性复核：`node scripts/index-observation.js`（默认站点 `https://img.fangkelianmeng.com`）。

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/front/antucao/image/sample` | GET | 随机取样（`pageSize`, `type`） |
| `/api/v1/front/antucao/image/rank` | GET | 排行榜（`page`, `pageSize`, `sort`） |
| `/api/v1/front/antucao/image/search` | GET | 搜索（`keyword`, `page`, `pageSize`, `type`） |
| `/api/v1/front/antucao/image/detail` | GET | 详情（`id`） |
| `/api/v1/front/antucao/image/operation` | POST | 互动计数（`img_id`, `type`, `inc`） |
| `/api/v1/front/antucao/image/error` | POST | 失效上报（`img_id`） |

## 筛选与 URL 参数（WO-187）

首页 / 全部图片页的筛选态写进 URL，可分享、可用浏览器前进后退逐档恢复。所有维度正交叠加：分类 / 分辨率 / 宽高比 / 主色调 / 搜索 / 排序。

| 参数 | 含义 | 生效范围 |
|------|------|----------|
| `type` | 分类码（如 `anime` / `4K`） | 服务端 `rank` / `search` |
| `size` | 分辨率档：① 画质/体积档 `uhd` / `hd` / `sd`（换算 `minSize` / `maxSize`）；② 设备尺寸预设 `phone`(1080×1920) / `desktop`(1920×1080) / `2k`(2560×1440) / `4k`(3840×2160) | ① 服务端；② **客户端**（按图片真实 `width` / `height` 判定「至少达到」该尺寸，后端仅沿用 `minSize=1` 排除未落库项，不按文件体积臆测像素分辨率） |
| `aspect` | 宽高比 `landscape` / `portrait` / `square` | **客户端**（后端无 ratio 参数，按已加载图的 `width` / `height` 本地过滤） |
| `color` | 主色调 `red` / `orange` / `yellow` / `green` / `blue` / `purple` / `mono` | **客户端**；仅在图源确实带可用主色调字段时写入与生效（见下方数据门控） |
| `s` | 搜索关键词 | 服务端 `search` |
| `sort` | 排序（`download` / `like` / `view` …；搜索态不写，避免死参数） | 服务端 `rank` |

- 首次落地用 `replaceState` 规范化 URL，后续交互用 `pushState`；`popstate` 监听恢复全部筛选维度（含 `color`）并重渲染；`syncBrowseUrl` 保持「搜索态刻意不写 `sort`」的既有语义不变。
- 「高级筛选」可折叠面板（`<details>`）整合类别（沿用 `type`）/ 分辨率 / 宽高比 / 主色调，面板内提供「重置筛选」；工具栏另有「清除筛选」与「随机一张」。
- 「随机一张」从**当前可见结果集**（已叠加全部客户端过滤）随机挑一张打开灯箱；无结果时显示空态提示，不跳死链（首屏 SSG 静态卡场景回退到有效详情页链接）。
- **主色调数据门控**：中台 image 接口、`data/*.json`、121 个预渲染详情页均无 dominant color / palette 等可用主色调字段，故该维度**显式禁用**，面板标注「图源暂无主色调数据」，控件置灰不可点、不写 `color` 参数、不参与过滤，**绝不伪造颜色**；仅当运行时图片数据确实带可用主色调字段（`dominantColor` / `mainColor` / `colorHex` / `palette` 等）时才自动启用控件、`color` 参数生效并支持前进/后退恢复。
- 搜索态不支持交互排序（`search` 接口无 sort），下拉复位为默认，URL 也不写 `sort`。

## 本地开发

纯静态站，直接用浏览器打开 `index.html` 或用任意 HTTP 服务器：

```bash
# Python
python -m http.server 8080

# Node
npx serve .

# PHP
php -S localhost:8080
```

## 部署

参考 `deploy/nginx.conf`，将全部文件上传至服务器 `/www/wwwroot/img.fangkelianmeng.com`（push `main` 由 self-hosted runner 自动同步），域名 `img.fangkelianmeng.com` 指向该目录即可。

### 内容路由回退壳与远端收尾腿（WO-258）

- `/p/<id>` 详情页下线后，同 URL **仍返回 200**（回退到 `p/_shell.html`），不产生 404 坏链：仓内参考档 `deploy/nginx-p-fallback.conf`，线上落位 `/www/server/panel/vhost/nginx/extension/img.fangkelianmeng.com/p-fallback.conf`。
- CI 的 `tar` 同步是增量覆盖（只增不删），构建期 `build.js` 清退掉的旧详情页仍会残留在服务器上返回 200 ⇒ `deploy.yml` 在 sync 之后接两步收尾腿：① 幂等确保回退壳在位（线上已有则完全不动；缺失才备份落位 → `nginx -t` → reload → 复验 → 失败回滚）；② 以**线上 `sitemap.xml`** 为权威清单做差集，删除「磁盘有、清单无」且文件名命中 `^[0-9a-f]{32}[.]html$` 的页（删后抽样旧链须 200 + 壳标记，复跑差集为 0）。
- 脚本事实源在 packages 单源：`packages/static-build-kit/src/remote-ensure-fallback.sh` + `remote-prune.sh`；回归用例 `packages/static-build-kit/test/remote-prune.test.sh`。
- 诊断报告落站点根目录之外（`<站点根同级>/.prune-diag/`），成功即删、异常才保留，不经 HTTP 对外暴露。
- 2026-11-17 生产实清理：删 259 个过期详情页，磁盘 122 = 清单 121 + 壳，二次差集 0，旧链抽样全 200 + 壳标记。

## 收录观测

- 台账：`data/index-observation.json`，与构建产出的 `sitemap.xml` 一一对应（WO-155 2026-11-21 正常扩容重建后 328 条：5 主页面 + 23 分类落地页 + 300 详情精选页）；CI 的 site-shell 注入 `sites.html` 后线上为 329 条（6 主页面 + 23 + 300，2026-11-21 线上实测）。`http_status / checked_at` 由脚本回写，`indexed` 不人工回填。
- 核对：`node scripts/index-observation.js`（`--no-write` 只看不写）逐条查 HTTP / canonical / robots / sitemap，并校验 http→https，回写 `http_status / checked_at`，报告写到 `reports/index-observation-YYYY-MM-DD.md`（含百度 / GSC 核对入口）。
- 2026-10-23 生产实测（精选集预渲染上线）：147 条全部 `200`、canonical 与 URL 一致、robots 放行、均在 sitemap；页内 /p/ 与 /category/ 内链断链 0；`detail-set.js` 121 条与 sitemap 详情页 1:1 零孤儿；`sitemap.xml` 已提交百度 / GSC，按 D-index-backfill 收录状态不再人工回填（`indexed` 保持 `unknown`）。
- 2026-11-10（WO-187）：选品逻辑校正后重建，`p/` 121 页、`detail-set.js` 121 条、`sitemap.xml` 148 条三者 1:1 一致（此前线上仅 72 / 仓库 49，与 README 声明的 121 不符）。

## 编码规范

所有文本文件必须 UTF-8（无 BOM）、LF 换行。详见知识库《静态网站字符编码规范》。
