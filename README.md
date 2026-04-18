# Blog Helper

[中文文档](README_zh.md)

Lightweight analytics toolkit for static blogs — PV/UV tracking, popular articles ranking, multi-site support from a single instance.

Data is isolated per site via `site_id`, auto-detected from the request hostname. One backend serves all your blogs.

## Dashboard

![Dashboard](dashboard.jpg)

## Features

- **Page View Tracking** — PV + UV per page, with browser fingerprint-based dedup
- **Batch Stats** — fetch counts for an entire article list in one request
- **Popular Articles** — ranked by PV over configurable time periods (7d / 30d / all)
- **Multi-Site** — one instance, N sites, data fully isolated by hostname
- **Zero-Dependency SDK** — single JS file, auto-detects page type, renders stats into your theme
- **Graceful Degradation** — if the backend is down, the blog works normally with no JS errors
- **Dashboard** — password-protected analytics dashboard with trend charts, visitors, referrers, and raw access logs

## Architecture

```
blog-helper/
├── cmd/server/main.go              # HTTP server entry point + graceful shutdown
├── internal/
│   ├── config/config.go            # Configuration (flags + env vars)
│   ├── handler/
│   │   ├── analytics.go            # API: report, stats, batch, popular
│   │   ├── dashboard.go            # Dashboard: single-page analytics UI
│   │   ├── health.go               # API: health check
│   │   └── middleware.go           # CORS, logging, recovery, real-ip, dashboard auth
│   ├── model/analytics.go          # Domain types
│   ├── store/
│   │   ├── store.go                # Repository interface
│   │   └── sqlite.go              # SQLite implementation + embedded migration
│   └── service/analytics.go        # Business logic: dedup, bot filter, rate limit
├── migrations/001_init.sql         # Schema reference (actual DDL in sqlite.go)
├── sdk/blog-helper.js              # Frontend JS SDK (zero-dependency, ~8KB)
├── scripts/dev-server.py           # Local dev server (static files + API proxy)
└── Makefile
```

## Quick Start

### 1. Run the backend

```bash
# Start Go backend on :9001
make run

# Or with custom options
go run ./cmd/server/ -addr 127.0.0.1:9001 -db ./data/blog-helper.db \
    -allowed-origins "https://your-site.com"
```

### 2. Add SDK to your blog

```html
<script src="asset/js/blog-helper.js" defer></script>
```

That's it. The SDK auto-detects:
- Current domain → `site_id`
- Page type (article list vs single post)
- API base URL (same origin `/api/v1/analytics`)

### 3. Local development

```bash
# Terminal 1: Go backend
make run

# Terminal 2: dev server (static files + reverse proxy to backend)
SITE_DIR=/path/to/your-blog make dev
```

The dev server serves your static blog on `http://localhost:4000` and proxies `/api/` requests to the Go backend.

## API

Base path: `/api/v1`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/analytics/report` | Report a page view, returns updated PV/UV |
| `GET` | `/api/v1/analytics/stats?slug=...&site_id=...` | Get stats for a single page |
| `POST` | `/api/v1/analytics/stats/batch` | Batch get stats (body: `{"site_id":"...","slugs":[...]}`) |
| `GET` | `/api/v1/analytics/popular?limit=10&period=30d&site_id=...` | Popular articles ranking |
| `GET` | `/api/v1/analytics/trend?days=30&site_id=...` | PV/UV trend (supports slug filter) |
| `GET` | `/api/v1/analytics/referrers?days=30&site_id=...` | Top referrer domains |
| `GET` | `/api/v1/analytics/visitors?site_id=...` | Recent unique visitors |
| `GET` | `/api/v1/analytics/views?site_id=...` | Raw page view records (auth required) |
| `GET` | `/api/v1/analytics/summary?period=30d&site_id=...` | PV/UV summary for a period |
| `GET` | `/api/v1/dashboard` | Analytics dashboard (auth required) |
| `GET` | `/api/v1/health` | Health check |

### Request / Response Examples

**Report a page view:**

```bash
curl -X POST http://localhost:9001/api/v1/analytics/report \
  -H "Content-Type: application/json" \
  -d '{"page_slug":"/2024/01/hello","page_title":"Hello World","fingerprint":"abc123"}'
# → {"ok":true,"data":{"pv":42,"uv":18}}
```

**Batch query:**

```bash
curl -X POST http://localhost:9001/api/v1/analytics/stats/batch \
  -H "Content-Type: application/json" \
  -d '{"site_id":"your-site.com","slugs":["/post-a","/post-b"]}'
# → {"ok":true,"data":{"/post-a":{"pv":100,"uv":50},"/post-b":{"pv":200,"uv":80}}}
```

**Error format:**

```json
{"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many requests"}}
```

## SDK Configuration

The SDK works with zero configuration. Override defaults when needed:

```html
<script>
window.BlogHelperConfig = {
  apiBase: "https://your-domain.com/api/v1/analytics",
  selectors: {
    listItems: ".post-item",          // Article list item selector
    listItemLink: "a",                // Link inside each list item
    postContainer: "article.post",    // Single post wrapper
    postMeta: "article.post time",    // Where to insert PV/UV on post page
    sidebarMount: "#ba-popular-mount" // Where to render popular articles
  },
  features: {
    reportPV: true,         // Report page views
    showListPV: true,       // Show PV on article list pages
    showPostStats: true,    // Show PV/UV on single post pages
    showPopular: true,      // Show popular articles in sidebar
    popularLimit: 8,        // Number of popular articles
    popularPeriod: "30d"    // Time period: "7d", "30d", "all"
  },
  pvLabel: "Views",         // Display label for page views
  uvLabel: "Visitors",      // Display label for unique visitors
  popularTitle: "Hot Posts"  // Sidebar section title
};
</script>
<script src="asset/js/blog-helper.js" defer></script>
```

### Browser Fingerprint

The SDK generates a lightweight browser fingerprint (screen resolution, canvas, timezone, etc.) hashed with SHA-256. No cookies required for the fingerprint itself — a cookie (`_bh_fp`) is used only to persist the hash across page loads for consistent UV counting.

### UV Calculation

UV (Unique Visitors) is deduplicated via `COUNT(DISTINCT fingerprint)`. When a visitor has no fingerprint (e.g., bots, JS disabled, privacy-hardened browsers), all such visits are counted as a single "unknown" visitor. This means UV may slightly undercount when multiple distinct visitors lack fingerprints, but ensures UV is always >= 1 when PV > 0.

### Dashboard Time Ranges

The trend chart supports sub-daily periods (1h, 6h, 1d) and daily periods (7d, 30d, 90d, 180d, 365d). The Visitors and Raw Views panels always use day-level granularity: sub-daily periods (1h/6h/1d) fall back to showing the last 1 day of data.

## Anti-Abuse

| Layer | Mechanism | Detail |
|-------|-----------|--------|
| Backend (service) | In-memory sliding window | Same fingerprint + slug: deduped within 30s |
| Backend (service) | Bot UA filter | Known crawlers (Googlebot, etc.) are not counted |
| Nginx (optional) | `limit_req` per IP | Recommended: 10 req/s, burst 20 |

## Configuration

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-addr` | `BH_ADDR` | `127.0.0.1:9001` | Listen address |
| `-db` | `BH_DB` | `./data/blog-helper.db` | SQLite database path |
| `-allowed-origins` | `BH_ALLOWED_ORIGINS` | `https://your-site.com` | CORS allowed origins (comma-separated) |
| `-dashboard-pass` | `BH_DASHBOARD_PASS` | `helper` | Dashboard login password |
| `-debug` | — | `false` | Expose version in health endpoint |

## Deployment

### Build

```bash
# Build for current platform
make build

# Build for Linux amd64 (typical server)
make build-linux
```

### Docker Compose (recommended)

Run blog-helper alongside nginx in docker-compose. The backend listens inside the Docker network only — no port exposed to the host.

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

Nginx proxies `/api/` to the backend via container name:

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
Restart=always
```

## Tech Stack

- **Backend**: Go 1.21+ — stdlib `net/http`, no framework
- **Database**: SQLite via [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) — pure Go, no CGO
- **Frontend SDK**: Vanilla JS, zero dependencies, ~8KB
- **Deploy**: Docker Compose / systemd + nginx reverse proxy

## License

MIT
