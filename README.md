# 小满美图（img.fangkelianmeng.com）

高清壁纸图片精选站，汇聚海量精美壁纸，支持搜索、分类浏览与热门排行。

## 技术栈

- **零依赖纯静态站**：HTML + CSS + Vanilla JS，无框架、无构建工具
- **三层 CSS 架构**：`tokens.css`（设计令牌）→ `main.css`（站点基础）→ `gallery.css`（画廊专用）
- **模块化 JS**：`tracker.js`（埋点 SDK）→ `app.js`（主题/菜单）→ `gallery.js`（画廊交互）
- **API 数据源**：`/api/v1/front/antucao/image/` 系列接口（sample / rank / search / detail）
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
│       └── gallery.js       # 图片画廊交互核心
├── data/
│   └── categories.json      # 分类定义
├── deploy/
│   └── nginx.conf           # Nginx 配置参考
├── index.html               # 首页（搜索 + 精选壁纸）
├── browse.html              # 全部图片（分页 + 排序）
├── rank.html                # 热门排行
├── category.html            # 分类浏览
├── about.html               # 关于与免责
├── 404.html                 # 404 页面
├── sw.js                    # Service Worker
├── robots.txt               # 搜索引擎爬虫规则
├── sitemap.xml              # 站点地图
├── manifest.webmanifest     # PWA 清单
└── .gitignore
```

## 页面说明

| 页面 | 文件 | 说明 |
|------|------|------|
| 首页 | `index.html` | Hero 搜索 + 分类 chip + 瀑布流精选壁纸 |
| 全部图片 | `browse.html` | 分页浏览 + 多排序方式 |
| 热门排行 | `rank.html` | 按下载/点赞/浏览排序 |
| 分类 | `category.html` | 9 大分类卡片入口 |
| 关于 | `about.html` | 数据来源、版权声明、FAQ |
| 404 | `404.html` | 页面走丢了 |

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

参考 `deploy/nginx.conf`，将全部文件上传至服务器 `/var/www/main-img`，配置域名 `img.fangkelianmeng.com` 指向该目录即可。

## 编码规范

所有文本文件必须 UTF-8（无 BOM）、LF 换行。详见知识库《静态网站字符编码规范》。
