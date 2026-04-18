# Blog Helper

[English](README.md)

轻量级静态博客分析后端 — PV/UV 统计、热门文章、趋势图、内置 Dashboard。一个实例服务多个站点，按域名自动隔离数据。

![Dashboard](dashboard.jpg)

## 功能

- **浏览量统计** — 每页 PV + UV，浏览器指纹去重
- **批量查询** — 文章列表页一次请求获取所有计数
- **热门文章** — 按 PV 排行，支持 7d / 30d / 全部
- **分析面板** — 密码保护的 Dashboard，含趋势图、来源、访客、原始访问记录
- **多站点** — 一个实例，N 个站点，`site_id` 自动从域名提取，数据完全隔离
- **零依赖 SDK** — 单个 JS 文件（~8KB），自动识别页面类型，渲染统计数据
- **优雅降级** — 后端宕机时博客正常工作，无 JS 报错

## 快速开始

### 1. 启动后端

```bash
make run

# 或自定义参数
go run ./cmd/server/ -addr 127.0.0.1:9001 -db ./data/blog-helper.db \
    -allowed-origins "https://your-site.com"
```

### 2. 博客引入 SDK

```html
<script src="asset/js/blog-helper.js" defer></script>
```

零配置即可工作。SDK 自动检测域名、页面类型、API 地址。

### 3. 本地开发

```bash
# 终端 1：Go 后端
make run

# 终端 2：开发服务器（静态文件 + 反向代理）
SITE_DIR=/path/to/your-blog make dev
```

开发服务器在 `http://localhost:4000` 提供静态文件，`/api/` 代理到 Go 后端。

## API

基础路径：`/api/v1`

### 公开接口（SDK 调用）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/analytics/report` | 上报浏览，返回最新 PV/UV |
| `GET` | `/analytics/stats?slug=...&site_id=...` | 单页统计 |
| `POST` | `/analytics/stats/batch` | 批量查询（`{"site_id":"...","slugs":[...]}`) |
| `GET` | `/analytics/popular?limit=10&period=30d&site_id=...` | 热门文章排行 |

### Dashboard 接口（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/analytics/trend?days=30&site_id=...` | PV/UV 趋势（可选 `&slug=` 筛选） |
| `GET` | `/analytics/referrers?days=30&site_id=...` | 来源域名排行 |
| `GET` | `/analytics/visitors?site_id=...` | 最近独立访客 |
| `GET` | `/analytics/views?site_id=...&limit=50` | 原始访问记录 |
| `GET` | `/analytics/summary?period=30d&site_id=...` | 时间段 PV/UV 汇总 |
| `GET` | `/dashboard` | 分析面板 |
| `GET` | `/health` | 健康检查 |

### 示例

```bash
# 上报浏览量
curl -X POST http://localhost:9001/api/v1/analytics/report \
  -H "Content-Type: application/json" \
  -d '{"page_slug":"/2024/01/hello","page_title":"Hello World","fingerprint":"abc123"}'
# → {"ok":true,"data":{"pv":42,"uv":18}}

# 批量查询
curl -X POST http://localhost:9001/api/v1/analytics/stats/batch \
  -H "Content-Type: application/json" \
  -d '{"site_id":"your-site.com","slugs":["/post-a","/post-b"]}'
# → {"ok":true,"data":{"/post-a":{"pv":100,"uv":50},"/post-b":{"pv":200,"uv":80}}}
```

错误格式：`{"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many requests"}}`

## SDK

零配置即可工作，需要时可覆盖：

```html
<script>
window.BlogHelperConfig = {
  apiBase: "https://your-domain.com/api/v1/analytics",
  selectors: {
    listItems: ".post-item",
    listItemLink: "a",
    postContainer: "article.post",
    postMeta: "article.post time",
    sidebarMount: "#ba-popular-mount"
  },
  features: {
    reportPV: true,
    showListPV: true,
    showPostStats: true,
    showPopular: true,
    popularLimit: 8,
    popularPeriod: "30d"    // "7d", "30d", "all"
  },
  pvLabel: "阅读",
  uvLabel: "访客",
  popularTitle: "Hot Posts"
};
</script>
<script src="asset/js/blog-helper.js" defer></script>
```

**浏览器指纹**：SDK 采集轻量级浏览器信号（屏幕、canvas、时区等），SHA-256 哈希。Cookie（`_bh_fp`）仅用于持久化哈希值。博客场景下 5-10% 偏差完全可接受。

**UV 计算**：`COUNT(DISTINCT fingerprint)` 去重。无 fingerprint 的访客（爬虫、JS 未执行、隐私浏览器）统一计为 1 个"未知访客"。保证 PV > 0 时 UV >= 1。

## Dashboard

密码保护，访问 `/api/v1/dashboard`。通过 `-dashboard-pass` 参数或 `BH_DASHBOARD_PASS` 环境变量配置（默认 `helper`）。

**面板**：在线访客、PV/UV 趋势图、热门文章、来源域名、访客列表、原始访问记录。

**时间范围**：趋势图支持 1h、6h、1d、7d、30d、90d、180d、365d。访客 / 原始记录面板使用天级粒度（子日级别回退为 1 天）。

**文章钻取**：点击热门文章中的任意文章，趋势图和来源自动筛选到该页面。

## 配置

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `-addr` | `BH_ADDR` | `127.0.0.1:9001` | 监听地址 |
| `-db` | `BH_DB` | `./data/blog-helper.db` | SQLite 数据库路径 |
| `-allowed-origins` | `BH_ALLOWED_ORIGINS` | `https://your-site.com` | CORS 允许的源（逗号分隔） |
| `-dashboard-pass` | `BH_DASHBOARD_PASS` | `helper` | Dashboard 登录密码 |
| `-debug` | — | `false` | Debug 模式（health 暴露 version） |

## 防刷

| 层级 | 机制 | 说明 |
|------|------|------|
| 后端 | 滑动窗口去重 | 同一 fingerprint + slug 30 秒内去重 |
| 后端 | Bot UA 过滤 | Googlebot 等爬虫不计入 |
| Nginx（可选） | `limit_req` per IP | 建议 10 req/s，burst 20 |

## 部署

```bash
make build          # 当前平台
make build-linux    # linux/amd64
```

### Docker Compose（推荐）

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
    environment:
      - BH_DASHBOARD_PASS=your-password
    restart: always
```

Nginx 代理 `/api/`：

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
Environment=BH_DASHBOARD_PASS=your-password
Restart=always
```

### 数据备份

唯一需要备份的文件：`data/blog-helper.db`

```bash
scp root@your-server:/path/to/blog-helper/data/blog-helper.db ~/backup/
```

**存储估算**：日均 100 PV ≈ 年增 12MB，日均 1000 PV ≈ 年增 120MB。如需清理可删除 90 天前的 `page_views`（聚合数据不受影响）。

## 数据库

SQLite，DDL 内嵌为 Go const，首次启动自动建表。

| 表 | 用途 |
|----|------|
| `page_views` | 原始事件（每次访问一条），支持重新聚合 |
| `page_stats` | 聚合缓存（PV/UV），主键 `(site_id, page_slug)` |
| `daily_stats` | 每日每页聚合 |
| `site_daily_stats` | 站点级每日汇总 |

写入流程（单事务）：`page_views` → `page_stats` → `daily_stats` → `site_daily_stats` → 返回计数。

## 项目结构

```
blog-helper/
├── cmd/server/main.go              # 入口 + 优雅退出
├── internal/
│   ├── config/config.go            # 参数 + 环境变量
│   ├── handler/
│   │   ├── analytics.go            # API handlers
│   │   ├── dashboard.go            # Dashboard UI（单页）
│   │   ├── health.go               # 健康检查
│   │   └── middleware.go           # CORS、日志、Recovery、认证
│   ├── model/analytics.go          # 领域模型
│   ├── store/
│   │   ├── store.go                # 存储接口
│   │   └── sqlite.go              # SQLite 实现
│   └── service/analytics.go        # 去重、Bot 过滤、限流
├── sdk/blog-helper.js              # 前端 SDK（~8KB）
├── scripts/dev-server.py           # 开发服务器（静态 + 代理）
└── Makefile
```

## 技术栈

- **后端**：Go — 标准库 `net/http`，无框架
- **数据库**：SQLite — [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite)，纯 Go，无需 CGO
- **前端**：原生 JS，零依赖
- **部署**：Docker Compose / systemd + nginx

## Roadmap

- [x] PV/UV 统计
- [x] 多站点支持
- [x] 热门文章排行
- [x] 批量查询
- [x] 浏览器指纹去重
- [x] Bot 过滤 + 限流
- [x] 访问趋势图
- [x] 全站 Dashboard
- [ ] 评论系统
- [ ] SDK 压缩版
- [ ] 单元测试

## License

MIT
