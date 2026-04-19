# Blog Helper

[English](README.md)

轻量级静态博客分析与评论系统 — PV/UV 统计、热门文章、趋势图、评论审核管理、内置 Dashboard。一个实例服务多个站点，按域名自动隔离数据。

![Dashboard](dashboard.jpg)
![Dashboard Comments](dashboard2.jpg)
![Comments](comments.jpg)

## 功能

- **浏览量统计** — 每页 PV + UV，浏览器指纹去重
- **批量查询** — 文章列表页一次请求获取所有计数
- **热门文章** — 按 PV 排行，支持 7d / 30d / 全部
- **分析面板** — 密码保护的 Dashboard，含趋势图、来源、访客、原始访问记录、评论管理
- **多站点** — 一个实例，N 个站点，`site_id` 自动从域名提取，数据完全隔离
- **评论系统** — 邮箱身份认证，Markdown 支持，Emoji 表情回应，Cookie Token 持久化
- **文章表态** — 每篇文章独立的爱心按钮，不依赖评论模式
- **零依赖 SDK** — JS + CSS + Markdown 库，自动识别页面类型，渲染统计数据
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
<link rel="stylesheet" href="asset/js/blog-helper.css">
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

### 评论 & 表态（公开）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/comments/config?site_id=...` | 查询站点评论模式 |
| `GET` | `/comments?slug=...&site_id=...` | 获取页面评论 |
| `POST` | `/comments/post` | 发表评论（需 PoW） |
| `POST` | `/comments/count` | 批量评论数 |
| `GET` | `/comments/challenge?site_id=...` | 获取 PoW 挑战 |
| `POST` | `/comments/react` | 评论 Emoji 回应 |
| `GET` | `/comments/recent?site_id=...&limit=5` | 最近评论（侧边栏） |
| `GET` | `/comments/hot?site_id=...&limit=5` | 热门评论（按回应数） |
| `GET` | `/commenter/lookup?token=...` | 按 Token 查询评论者 |
| `POST` | `/commenter/profile` | 更新评论者资料 |
| `POST` | `/page/react` | 文章爱心表态 |
| `GET` | `/page/reactions?slug=...&site_id=...` | 获取文章表态数 |

### Dashboard 接口（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/analytics/trend?days=30&site_id=...` | PV/UV 趋势（可选 `&slug=` 筛选） |
| `GET` | `/analytics/referrers?days=30&site_id=...` | 来源域名排行 |
| `GET` | `/analytics/visitors?site_id=...` | 最近独立访客 |
| `GET` | `/analytics/views?site_id=...&limit=50` | 原始访问记录 |
| `GET` | `/analytics/summary?period=30d&site_id=...` | 时间段 PV/UV 汇总 |
| `GET` | `/comments/pending?site_id=...` | 待审评论（审核模式） |
| `POST` | `/comments/approve?id=...` | 通过评论 |
| `POST` | `/comments/reject?id=...` | 驳回评论 |
| `POST` | `/comments/delete?id=...` | 删除评论 |
| `GET` | `/comments/all?site_id=&limit=&offset=` | 全部评论（分页） |
| `POST` | `/comments/admin-reply` | 管理员以"作者"身份回复 |
| `GET` | `/comments/mode` | 获取当前评论模式 |
| `POST` | `/comments/mode` | 运行时切换评论模式 |
| `GET` | `/commenters/all?limit=&offset=` | 评论用户列表（分页） |
| `GET` | `/dashboard` | 分析 + 评论管理面板 |
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
<link rel="stylesheet" href="asset/js/blog-helper.css">
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
    showComments: "auto",   // true | "auto" | false
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

**面板**：在线访客、PV/UV 汇总、文章点赞数、评论用户数、趋势图、热门文章、来源域名、平台分布、访客列表、原始访问记录、评论管理。

**时间范围**：趋势图支持 1h、6h、1d、7d、30d、90d、180d、365d。所有统计卡片（PV/UV/Likes/Commenters）跟随时间范围筛选。

**文章钻取**：点击热门文章中的任意文章，趋势图和来源自动筛选到该页面。

**评论管理**：All / Pending / Commenters 子面板，管理员回复（Markdown），运行时模式切换，UA 解析为 `OS · Browser` 格式。

## 配置

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `-addr` | `BH_ADDR` | `127.0.0.1:9001` | 监听地址 |
| `-db` | `BH_DB` | `./data/blog-helper.db` | SQLite 数据库路径 |
| `-allowed-origins` | `BH_ALLOWED_ORIGINS` | `https://your-site.com` | CORS 允许的源（逗号分隔） |
| `-dashboard-pass` | `BH_DASHBOARD_PASS` | `helper` | Dashboard 登录密码 |
| `-comment-mode` | `BH_COMMENT_MODE` | `off` | 评论模式：`off`、`auto-approve`、`moderation` |
| `-debug` | — | `false` | Debug 模式（health 暴露 version） |

## 评论系统

通过 `-comment-mode auto-approve` 启用（或 `moderation` 需人工审核）。

**功能**：邮箱身份 + Cookie Token 持久化，嵌套回复，Markdown（写作/预览切换），Emoji 表情回应，个人资料编辑（博客地址、个性签名）。

**站点级控制**：SDK `showComments` 选项 — `true`（始终开启）、`"auto"`（从后端检测，默认）、`false`（禁用）。文章爱心表态独立于评论模式，始终可用。

**防机器人**：Proof-of-Work（SHA-256 前缀挑战）、频率限制（5 条/IP/分钟）、蜜罐字段。

## 防刷

| 层级 | 机制 | 说明 |
|------|------|------|
| 统计 | 滑动窗口去重 | 同一 fingerprint + slug 30 秒内去重 |
| 统计 | Bot UA 过滤 | Googlebot 等爬虫不计入 |
| 评论 | Proof-of-Work | 每次发评论前需解 SHA-256 挑战 |
| 评论 | 频率限制 | 每 IP 每分钟最多 5 条 |
| 评论 | 蜜罐字段 | 隐藏字段捕获机器人 |
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
| `commenters` | 评论者信息（邮箱、昵称、头像、签名） |
| `commenter_tokens` | 评论者登录 Token |
| `comments` | 评论内容（支持嵌套回复） |
| `comment_reactions` | 评论 Emoji 回应 |
| `page_reactions` | 文章爱心表态 |

写入流程（单事务）：`page_views` → `page_stats` → `daily_stats` → `site_daily_stats` → 返回计数。

## 项目结构

```
blog-helper/
├── cmd/server/main.go              # 入口 + 优雅退出
├── internal/
│   ├── config/config.go            # 参数 + 环境变量
│   ├── handler/
│   │   ├── analytics.go            # 统计 API handlers
│   │   ├── comment.go              # 评论 API handlers
│   │   ├── dashboard.go            # Dashboard UI（单页）
│   │   ├── health.go               # 健康检查
│   │   └── middleware.go           # CORS、日志、Recovery、认证
│   ├── model/
│   │   ├── analytics.go            # 统计领域模型
│   │   └── comment.go             # 评论领域模型
│   ├── store/
│   │   ├── store.go                # 存储接口
│   │   └── sqlite.go              # SQLite 实现
│   └── service/
│       ├── analytics.go            # 去重、Bot 过滤、限流
│       └── comment.go             # 评论业务逻辑
├── sdk/
│   ├── blog-helper.js              # 前端 SDK
│   ├── blog-helper.css             # SDK 样式
│   └── lib/marked.min.js           # Markdown 解析库（本地）
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
- [x] 评论系统
- [x] 文章表态（爱心）
- [ ] SDK 压缩版
- [ ] 单元测试

## License

MIT
