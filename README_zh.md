# Blog Helper

[English](README.md)

轻量级静态博客增强工具 — PV/UV 统计、热门文章排行、多站点支持，一个实例服务所有博客。

## 项目背景

静态博客（Jekyll、MWeb 等）天然缺少动态功能。Blog Helper 的目标是为静态博客注入「生命力」：

- **MVP（已完成）**：浏览量统计（PV/UV），跑通前后端全链路
- **下一步**：评论系统、访问趋势图、全站 Dashboard
- **远期**：AI 相关功能（文章摘要、智能推荐等）

设计原则：**一个后端实例服务多个站点**，通过 `site_id`（自动从请求域名提取）隔离数据。

## Dashboard

![Dashboard](dashboard.jpg)

## 功能

- **浏览量统计** — 每页 PV + UV，基于浏览器指纹去重
- **批量查询** — 文章列表页一次请求获取所有文章的计数
- **热门文章** — 按 PV 排行，支持 7 天 / 30 天 / 全部时间段
- **多站点** — 一个后端实例，N 个站点，数据完全隔离
- **零依赖 SDK** — 单个 JS 文件，自动识别页面类型，自动渲染统计数据
- **优雅降级** — 后端宕机时博客正常工作，无 JS 报错
- **分析面板** — 密码保护的 Dashboard，含趋势图、访客、来源、原始访问记录

## 项目结构

```
blog-helper/
├── cmd/server/main.go              # HTTP 服务入口 + 优雅退出
├── internal/
│   ├── config/config.go            # 配置（命令行参数 + 环境变量）
│   ├── handler/
│   │   ├── analytics.go            # API: 上报、查询、批量查询、热门文章
│   │   ├── dashboard.go            # Dashboard：单页分析面板
│   │   ├── health.go               # API: 健康检查
│   │   └── middleware.go           # CORS、日志、Recovery、真实 IP、Dashboard 认证
│   ├── model/analytics.go          # 领域模型
│   ├── store/
│   │   ├── store.go                # 存储接口（方便未来切换实现）
│   │   └── sqlite.go              # SQLite 实现（DDL 内嵌为 const）
│   └── service/analytics.go        # 业务逻辑：去重、Bot 过滤、限流
├── migrations/001_init.sql         # Schema 参考文件（实际 DDL 在 sqlite.go 中）
├── sdk/blog-helper.js              # 前端 JS SDK（零依赖，~8KB）
├── scripts/dev-server.py           # 本地开发服务器（静态文件 + API 代理）
└── Makefile
```

## 快速开始

### 1. 启动后端

```bash
# 在 :9001 端口启动（本地开发，带 debug 模式）
make run

# 或者自定义参数
go run ./cmd/server/ -addr 127.0.0.1:9001 -db ./data/blog-helper.db \
    -allowed-origins "https://your-site.com"
```

### 2. 博客中引入 SDK

```html
<script src="asset/js/blog-helper.js" defer></script>
```

零配置即可工作。SDK 会自动检测：
- 当前域名 → `site_id`
- 页面类型（文章列表 / 单篇文章）
- API 地址（同源 `/api/v1/analytics`）

### 3. 本地开发

```bash
# 终端 1：Go 后端
make run

# 终端 2：开发服务器（静态文件 + 反向代理到后端）
SITE_DIR=/path/to/your-blog make dev
```

开发服务器在 `http://localhost:4000` 提供博客静态文件，并将 `/api/` 请求代理到 Go 后端。

## API 接口

基础路径：`/api/v1`，为未来扩展（评论等）预留命名空间。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/analytics/report` | 上报浏览 + 返回最新 PV/UV |
| `GET` | `/api/v1/analytics/stats?slug=...&site_id=...` | 查询单页统计 |
| `POST` | `/api/v1/analytics/stats/batch` | 批量查询（body: `{"site_id":"...","slugs":[...]}`) |
| `GET` | `/api/v1/analytics/popular?limit=10&period=30d&site_id=...` | 热门文章排行 |
| `GET` | `/api/v1/analytics/trend?days=30&site_id=...` | PV/UV 趋势（支持 slug 筛选） |
| `GET` | `/api/v1/analytics/referrers?days=30&site_id=...` | 来源域名排行 |
| `GET` | `/api/v1/analytics/visitors?site_id=...` | 最近独立访客 |
| `GET` | `/api/v1/analytics/views?site_id=...` | 原始访问记录（需认证） |
| `GET` | `/api/v1/analytics/summary?period=30d&site_id=...` | 时间段 PV/UV 汇总 |
| `GET` | `/api/v1/dashboard` | 分析面板（需认证） |
| `GET` | `/api/v1/health` | 健康检查 |

### 请求/响应示例

**上报浏览量（同时返回最新计数）：**

```bash
curl -X POST http://localhost:9001/api/v1/analytics/report \
  -H "Content-Type: application/json" \
  -d '{"page_slug":"/2024/01/hello","page_title":"Hello World","fingerprint":"abc123"}'
# → {"ok":true,"data":{"pv":42,"uv":18}}
```

**批量查询（文章列表页用，避免 N 次请求）：**

```bash
curl -X POST http://localhost:9001/api/v1/analytics/stats/batch \
  -H "Content-Type: application/json" \
  -d '{"site_id":"your-site.com","slugs":["/post-a","/post-b"]}'
# → {"ok":true,"data":{"/post-a":{"pv":100,"uv":50},"/post-b":{"pv":200,"uv":80}}}
```

**统一错误格式：**

```json
{"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many requests"}}
```

## SDK 配置

SDK 默认零配置即可工作，需要时可覆盖：

```html
<script>
window.BlogHelperConfig = {
  apiBase: "https://your-domain.com/api/v1/analytics",
  selectors: {
    listItems: ".post-item",          // 文章列表项选择器
    listItemLink: "a",                // 列表项内的链接
    postContainer: "article.post",    // 文章页容器
    postMeta: "article.post time",    // 文章页中插入 PV/UV 的位置
    sidebarMount: "#ba-popular-mount" // 热门文章挂载点
  },
  features: {
    reportPV: true,         // 上报浏览量
    showListPV: true,       // 列表页显示 PV
    showPostStats: true,    // 文章页显示 PV/UV
    showPopular: true,      // 侧边栏显示热门文章
    popularLimit: 8,        // 热门文章数量
    popularPeriod: "30d"    // 时间范围: "7d", "30d", "all"
  },
  pvLabel: "阅读",          // PV 显示文案
  uvLabel: "观众",          // UV 显示文案
  popularTitle: "Hot Posts" // 侧边栏标题
};
</script>
<script src="asset/js/blog-helper.js" defer></script>
```

### 浏览器指纹

SDK 采集轻量级浏览器信号（屏幕分辨率、canvas、时区等），通过 SHA-256 生成哈希。Cookie（`_bh_fp`）仅用于持久化哈希值以保证跨页面 UV 计数一致。

博客场景下 5-10% 的偏差完全可接受，且无需用户授权。

### UV 计算说明

UV（独立访客）通过 `COUNT(DISTINCT fingerprint)` 去重。当访客无 fingerprint 时（如爬虫、JS 未执行、隐私浏览器等），所有无 fingerprint 的访问统一计为 1 个"未知访客"。这意味着多个无 fingerprint 的不同访客只会被计为 1 UV，但保证了 PV > 0 时 UV 始终 >= 1。

### Dashboard 时间范围

趋势图支持子日级别（1h、6h、1d）和天级别（7d、30d、90d、180d、365d）。Visitors 和 Raw Views 面板始终使用天级粒度：选择子日级别时间段（1h/6h/1d）时，实际展示最近 1 天的数据。

## 防刷策略

| 层级 | 机制 | 说明 |
|------|------|------|
| 后端（业务层） | 内存滑动窗口 | 同一 fingerprint + slug 30 秒内去重 |
| 后端（业务层） | Bot UA 过滤 | Googlebot 等爬虫不计入统计 |
| Nginx（可选） | `limit_req` per IP | 建议配置：10 req/s，burst 20 |

## 数据库设计

SQLite，DDL 内嵌为 Go const，首次启动自动建表。`migrations/001_init.sql` 仅作参考。

| 表 | 用途 |
|----|------|
| `page_views` | 原始事件表，每次访问一条记录，含 `site_id`，支持未来重新聚合 |
| `page_stats` | 聚合缓存表（PV/UV 计数），复合主键 `(site_id, page_slug)` |
| `daily_stats` | 每日聚合，为未来趋势图预留 |
| `site_daily_stats` | 站点级每日汇总，为未来全站 Dashboard 预留 |

**写入流程**（单事务）：INSERT page_views → UPSERT page_stats → UPSERT daily_stats → UPSERT site_daily_stats → 返回最新计数。

**存储估算**：日均 100 PV ≈ 年增 12MB，日均 1000 PV ≈ 年增 120MB。个人博客完全不需要担心。如需清理可删除 90 天前的 `page_views` 原始记录（聚合数据不受影响）。

## 配置参数

| 命令行参数 | 环境变量 | 默认值 | 说明 |
|-----------|---------|--------|------|
| `-addr` | `BH_ADDR` | `127.0.0.1:9001` | 监听地址 |
| `-db` | `BH_DB` | `./data/blog-helper.db` | SQLite 数据库路径 |
| `-allowed-origins` | `BH_ALLOWED_ORIGINS` | `https://your-site.com` | CORS 允许的源（逗号分隔） |
| `-dashboard-pass` | `BH_DASHBOARD_PASS` | `helper` | Dashboard 登录密码 |
| `-debug` | — | `false` | Debug 模式（health 接口暴露 version） |

## 部署

### 构建

```bash
# 当前平台
make build

# Linux amd64（服务器）
make build-linux
```

### Docker Compose（推荐）

blog-helper 与 nginx 同在 docker-compose 网络中，后端不暴露端口到宿主机。

```yaml
services:
  blog-helper:
    image: debian:bullseye-slim
    container_name: blog-helper
    volumes:
      - ./blog-helper:/app
    working_dir: /app
    command: ["./blog-helper", "-addr", "0.0.0.0:9001", "-db", "/app/data/blog-helper.db",
              "-allowed-origins", "https://site-a.com,https://site-b.com"]
    restart: always
```

Nginx 通过容器名代理 `/api/`：

```nginx
location /api/ {
    proxy_pass http://blog-helper:9001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 独立部署（systemd）

```ini
[Service]
ExecStart=/opt/blog-helper/blog-helper \
    -addr 127.0.0.1:9001 \
    -db /opt/blog-helper/data/blog-helper.db \
    -allowed-origins https://your-site.com
Restart=always
```

### 数据备份

唯一需要备份的文件：`data/blog-helper.db`

```bash
# 从 VPS 拉取备份
scp root@your-server:/path/to/blog-helper/data/blog-helper.db ~/backup/
```

## 主题集成

只需改 2 个文件，共 3 行代码：

**footer.html — 加载 SDK：**

```html
<!-- 可选：自定义选择器适配你的主题 -->
<script>
window.BlogHelperConfig = {
  selectors: { listItems: ".post-item", listItemLink: "a" }
};
</script>
<script src="asset/js/blog-helper.js" defer></script>
```

**sidebar.html — 热门文章挂载点：**

```html
<div id="ba-popular-mount"></div>
```

SDK 通过 DOM 选择器自动检测页面结构并渲染，其他模板文件不需要修改。

## 技术栈

- **后端**：Go 1.25+ — 标准库 `net/http`，无框架
- **数据库**：SQLite — [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite)，纯 Go 实现，无需 CGO
- **前端 SDK**：原生 JS，零依赖，~8KB
- **部署**：Docker Compose / systemd + nginx 反向代理

## Roadmap

- [x] PV/UV 统计（MVP）
- [x] 多站点支持（site_id 隔离）
- [x] 热门文章排行（sidebar）
- [x] 批量查询（列表页优化）
- [x] 浏览器指纹去重
- [x] Bot 过滤 + 限流
- [ ] 评论系统
- [x] 访问趋势图（支持 1h/6h/1d/7d/30d/90d/180d/365d）
- [x] 全站 Dashboard（认证保护，实时刷新，文章钻取）
- [ ] SDK 压缩版（blog-helper.min.js）
- [ ] 单元测试

## License

MIT
