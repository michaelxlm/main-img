# 小满美图（img.fangkelianmeng.com）

高清壁纸图片精选站，汇聚海量精美壁纸，支持搜索、分类浏览与热门排行。

## 技术栈

- **零依赖纯静态站**：HTML + CSS + Vanilla JS，无框架、无构建工具
- **三层 CSS 架构**：`tokens.css`（设计令牌）→ `main.css`（站点基础）→ `gallery.css`（画廊专用）
- **模块化 JS**：`tracker.js`（埋点 SDK）→ `app.js`（主题/菜单）→ `gallery.js`（画廊交互）
- **API 数据源**：`/api/v1/front/antucao/image/` 系列接口（sample / rank / search / detail）
- **缩略图提速**：列表缩略图/灯箱展示图走 OSS `x-oss-process` 裁剪（w_400/w_1920 + webp），下载仍用原图；失效时回退原图→外链→上报
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
| 首页 | `index.html` | Hero 搜索 + 21 分类 chip + 瀑布流精选壁纸（滚动自动加载） |
| 全部图片 | `browse.html` | 分页浏览 + 多排序方式，展示总张数 |
| 热门排行 | `rank.html` | 按下载/点赞/浏览排序，卡片带名次角标（前 3 名金银铜） |
| 分类 | `category.html` | 21 大分类卡片入口（链向落地页） |
| 分类落地页 | `category/{slug}.html` | 构建期预渲染（每类首屏 20 张静态卡 + SEO 文案），`build.js` 生成、勿手改 |
| 详情精选页 | `p/{id}.html` | 构建期预渲染（大图/元信息/下载/同类推荐/ImageObject，上限 200），`build.js` 生成、勿手改 |
| 我的收藏 | `favorites.html` | 浏览本地收藏，支持取消/清空（noindex，不进 sitemap） |
| 关于 | `about.html` | 数据来源、版权声明、FAQ |
| 404 | `404.html` | 页面走丢了 |

灯箱预览能力：第 n/共 N 计数、收藏（与卡片双向同步）、左右键/触屏滑动切换、相邻大图预加载、热度数据展示；打开灯箱会补报一次浏览、下载时补报一次下载计数（供热度排序积累真实数据）；命中详情精选集（`detail-set.js` 的 `window.GM_DETAIL_IDS`）时展示「查看详情 →」链向 `/p/{id}.html`。

## 构建（精选集预渲染）

```bash
node scripts/build.js
```

拉取中台 sample/rank 接口 → 枚举真实分类码（`data/type-registry.json` 累计登记防抽样抖动）→ 生成 `category/*.html` 与 `p/*.html`（仅预渲染精选集，全量 33 万图仍运行时取数）→ 重写 `sitemap.xml`（主页面 + 全部生成页）→ 同步收录台账 → CSS/JS 盖 `?v=` 令牌（`detail-set.js` 故意不盖、保持常新）。API 不可达则降级为只重写主页面 sitemap、保留既有生成页。生成页为产物，需随仓库 commit（deploy 工作流无构建步骤）。

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/front/antucao/image/sample` | GET | 随机取样（`pageSize`, `type`） |
| `/api/v1/front/antucao/image/rank` | GET | 排行榜（`page`, `pageSize`, `sort`） |
| `/api/v1/front/antucao/image/search` | GET | 搜索（`keyword`, `page`, `pageSize`, `type`） |
| `/api/v1/front/antucao/image/detail` | GET | 详情（`id`） |
| `/api/v1/front/antucao/image/operation` | POST | 互动计数（`img_id`, `type`, `inc`） |
| `/api/v1/front/antucao/image/error` | POST | 失效上报（`img_id`） |

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

## 收录观测

- 台账：`data/index-observation.json`，与 `sitemap.xml` 一一对应（现 147 条：5 主页面 + 21 分类落地页 + 121 详情精选页）；`http_status / checked_at` 由脚本回写，`indexed` 不人工回填。
- 核对：`node scripts/index-observation.js`（`--no-write` 只看不写）逐条查 HTTP / canonical / robots / sitemap，并校验 http→https，回写 `http_status / checked_at`，报告写到 `reports/index-observation-YYYY-MM-DD.md`（含百度 / GSC 核对入口）。
- 2026-10-23 生产实测（精选集预渲染上线）：147 条全部 `200`、canonical 与 URL 一致、robots 放行、均在 sitemap；页内 /p/ 与 /category/ 内链断链 0；`detail-set.js` 121 条与 sitemap 详情页 1:1 零孤儿；`sitemap.xml` 已提交百度 / GSC，按 D-index-backfill 收录状态不再人工回填（`indexed` 保持 `unknown`）。

## 编码规范

所有文本文件必须 UTF-8（无 BOM）、LF 换行。详见知识库《静态网站字符编码规范》。
