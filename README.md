# Blog Helper

[中文文档](README_zh.md)

Lightweight analytics and comment system for static blogs — PV/UV tracking, popular articles, trend charts, comment moderation, and a built-in dashboard. One instance serves multiple sites, isolated by hostname.

**Analytics Dashboard**
![Dashboard](dashboard.jpg)

**Comment Section on Blog Post**
![Comments](comments.jpg)

**Comment Management**
![Dashboard Comments](dashboard2.jpg)

## Features

- **Page View Tracking** — PV + UV per page, browser fingerprint dedup
- **Batch Stats** — fetch counts for an article list in one request
- **Popular Articles** — ranked by PV, configurable period (7d / 30d / all)
- **Analytics Dashboard** — password-protected, with trend charts, referrers, visitors, raw access logs, and comment management
- **Multi-Site** — one instance, N sites, data isolated by `site_id` (auto-detected from hostname)
- **Comment System** — email-based identity, Markdown support, emoji reactions, cookie token persistence
- **Page Reactions** — per-article heart button, independent of comment mode
- **Zero-Dependency SDK** — single JS file + CSS, auto-detects page type, renders stats into your theme
- **Graceful Degradation** — backend down? Blog works normally, no JS errors

## Quick Start

### 1. Run the backend

```bash
make run

# Or with custom options
go run ./cmd/server/ -addr 127.0.0.1:9001 -db ./data/blog-helper.db \
    -allowed-origins "https://your-site.com"
```

### 2. Add SDK to your blog

```html
<link rel="stylesheet" href="asset/js/blog-helper.css">
<script src="asset/js/blog-helper.js" defer></script>
```

Zero config required. The SDK auto-detects current domain, page type, and API URL.

### 3. Local development

```bash
# Terminal 1: Go backend
make run

# Terminal 2: dev server (static files + reverse proxy)
SITE_DIR=/path/to/your-blog make dev
```

Dev server on `http://localhost:4000`, proxies `/api/` to the Go backend.

## API

Base path: `/api/v1`

### Public (SDK-facing)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/analytics/report` | Report a page view, returns updated PV/UV |
| `GET` | `/analytics/stats?slug=...&site_id=...` | Stats for a single page |
| `POST` | `/analytics/stats/batch` | Batch stats (`{"site_id":"...","slugs":[...]}`) |
| `GET` | `/analytics/popular?limit=10&period=30d&site_id=...` | Popular articles ranking |

### Comments & Reactions (public)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/comments/config?site_id=...` | Comment mode for the site |
| `GET` | `/comments?slug=...&site_id=...` | Get comments for a page |
| `POST` | `/comments/post` | Post a comment (PoW required) |
| `POST` | `/comments/count` | Batch comment counts |
| `GET` | `/comments/challenge?site_id=...` | Get PoW challenge |
| `POST` | `/comments/react` | React (emoji) to a comment |
| `GET` | `/comments/recent?site_id=...&limit=5` | Recent comments (sidebar) |
| `GET` | `/comments/hot?site_id=...&limit=5` | Hot comments by reaction count |
| `GET` | `/commenter/lookup?token=...` | Look up commenter by token |
| `POST` | `/commenter/profile` | Update commenter profile |
| `POST` | `/page/react` | React (heart) to a page |
| `GET` | `/page/reactions?slug=...&site_id=...` | Get page reaction counts |

### Dashboard (auth required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/analytics/trend?days=30&site_id=...` | PV/UV trend (optional `&slug=` filter) |
| `GET` | `/analytics/referrers?days=30&site_id=...` | Top referrer domains |
| `GET` | `/analytics/visitors?site_id=...` | Recent unique visitors |
| `GET` | `/analytics/views?site_id=...&limit=50` | Raw page view records |
| `GET` | `/analytics/summary?period=30d&site_id=...` | PV/UV summary for a period |
| `GET` | `/comments/pending?site_id=...` | Pending comments (moderation) |
| `POST` | `/comments/approve?id=...` | Approve a comment |
| `POST` | `/comments/reject?id=...` | Reject a comment |
| `POST` | `/comments/delete?id=...` | Delete a comment |
| `GET` | `/comments/all?site_id=&limit=&offset=` | All comments (paginated) |
| `POST` | `/comments/admin-reply` | Admin reply as "Author" |
| `GET` | `/comments/mode` | Get current comment mode |
| `POST` | `/comments/mode` | Switch comment mode at runtime |
| `GET` | `/commenters/all?limit=&offset=` | All commenters (paginated) |
| `GET` | `/dashboard` | Analytics + comment management UI |
| `GET` | `/health` | Health check |

### Examples

```bash
# Report a page view
curl -X POST http://localhost:9001/api/v1/analytics/report \
  -H "Content-Type: application/json" \
  -d '{"page_slug":"/2024/01/hello","page_title":"Hello World","fingerprint":"abc123"}'
# → {"ok":true,"data":{"pv":42,"uv":18}}

# Batch query
curl -X POST http://localhost:9001/api/v1/analytics/stats/batch \
  -H "Content-Type: application/json" \
  -d '{"site_id":"your-site.com","slugs":["/post-a","/post-b"]}'
# → {"ok":true,"data":{"/post-a":{"pv":100,"uv":50},"/post-b":{"pv":200,"uv":80}}}
```

Error format: `{"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many requests"}}`

## SDK

Zero config by default. Override when needed:

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
  pvLabel: "Views",
  uvLabel: "Visitors",
  popularTitle: "Hot Posts"
};
</script>
<script src="asset/js/blog-helper.js" defer></script>
```

**Browser Fingerprint**: The SDK hashes lightweight browser signals (screen, canvas, timezone, etc.) via SHA-256. A cookie (`_bh_fp`) persists the hash for consistent UV counting. No user consent required — 5-10% deviation is acceptable for blog analytics.

**UV Calculation**: `COUNT(DISTINCT fingerprint)`. Visitors without a fingerprint (bots, JS disabled, privacy browsers) are counted as 1 collective "unknown" visitor. UV is always >= 1 when PV > 0.

## Dashboard

Password-protected at `/api/v1/dashboard`. Set via `-dashboard-pass` flag or `BH_DASHBOARD_PASS` env var (default: `helper`).

**Panels**: Active visitors, PV/UV summary, article likes, commenters, trend chart, popular articles, referrer domains, platforms, visitor list, raw access logs, comment management.

**Time ranges**: Trend chart supports 1h, 6h, 1d, 7d, 30d, 90d, 180d, 365d. All stat cards (PV/UV/Likes/Commenters) respect the selected period.

**Article drill-down**: Click any article in Popular to filter trend and referrers to that page.

**Comment management**: All/Pending/Commenters sub-tabs, admin reply (Markdown), runtime mode switch, UA parsed as `OS · Browser`.

## Configuration

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-addr` | `BH_ADDR` | `127.0.0.1:9001` | Listen address |
| `-db` | `BH_DB` | `./data/blog-helper.db` | SQLite database path |
| `-allowed-origins` | `BH_ALLOWED_ORIGINS` | `https://your-site.com` | CORS origins (comma-separated) |
| `-dashboard-pass` | `BH_DASHBOARD_PASS` | `helper` | Dashboard login password |
| `-comment-mode` | `BH_COMMENT_MODE` | `off` | Comment mode: `off`, `auto-approve`, `moderation` |
| `-debug` | — | `false` | Expose version in health endpoint |

## Comment System

Enable with `-comment-mode auto-approve` (or `moderation` for manual review).

**Features**: email-based identity with cookie token, threaded replies, Markdown (Write/Preview tabs), emoji reactions on comments and pages, profile editing (blog URL, bio).

**Per-site control**: SDK `showComments` option — `true` (always on), `"auto"` (detect from backend, default), `false` (disabled). Page reactions (heart) work independently regardless of comment mode.

**Anti-bot**: Proof-of-Work (SHA-256 prefix challenge), rate limit (5 comments/IP/minute), honeypot field.

## Anti-Abuse

| Layer | Mechanism | Detail |
|-------|-----------|--------|
| Analytics | Sliding window dedup | Same fingerprint + slug within 30s |
| Analytics | Bot UA filter | Googlebot, etc. excluded |
| Comments | Proof-of-Work | SHA-256 challenge before each post |
| Comments | Rate limit | 5 comments per IP per minute |
| Comments | Honeypot | Hidden field traps bots |
| Nginx (optional) | `limit_req` per IP | Recommended: 10 req/s, burst 20 |

## Deployment

```bash
make build          # current platform
make build-linux    # linux/amd64
```

### Docker Compose (recommended)

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

Nginx proxies `/api/` to the backend:

```nginx
location /api/ {
    proxy_pass http://blog-helper:9001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### Standalone (systemd)

```ini
[Service]
ExecStart=/opt/blog-helper/blog-helper \
    -addr 127.0.0.1:9001 \
    -db /opt/blog-helper/data/blog-helper.db \
    -allowed-origins https://your-site.com
Environment=BH_DASHBOARD_PASS=your-password
Restart=always
```

## Project Structure

```
blog-helper/
├── cmd/server/main.go              # Entry point + graceful shutdown
├── internal/
│   ├── config/config.go            # Flags + env vars
│   ├── handler/
│   │   ├── analytics.go            # Analytics API handlers
│   │   ├── comment.go              # Comment API handlers
│   │   ├── dashboard.go            # Dashboard UI (single-page)
│   │   ├── health.go               # Health check
│   │   └── middleware.go           # CORS, logging, recovery, auth
│   ├── model/
│   │   ├── analytics.go            # Analytics domain types
│   │   └── comment.go             # Comment domain types
│   ├── store/
│   │   ├── store.go                # Repository interface
│   │   └── sqlite.go              # SQLite implementation
│   └── service/
│       ├── analytics.go            # Dedup, bot filter, rate limit
│       └── comment.go             # Comment business logic
├── sdk/
│   ├── blog-helper.js              # Frontend SDK
│   ├── blog-helper.css             # SDK styles
│   └── lib/marked.min.js           # Markdown parser (local)
├── scripts/dev-server.py           # Dev server (static + proxy)
└── Makefile
```

## Tech Stack

- **Backend**: Go — stdlib `net/http`, no framework
- **Database**: SQLite via [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) (pure Go, no CGO)
- **Frontend**: Vanilla JS, zero dependencies
- **Deploy**: Docker Compose / systemd + nginx

## License

MIT
