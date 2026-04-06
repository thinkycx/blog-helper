# Blog Helper

Static blog enhancement toolkit — page view tracking (PV/UV), multi-site support, future comments system, and more.

One service instance serves multiple sites. Data is isolated per site via `site_id` (auto-detected from hostname).

## Architecture

```
blog-helper/
├── cmd/server/main.go              # HTTP server entry point
├── internal/
│   ├── config/config.go            # Configuration (flags + env vars)
│   ├── handler/
│   │   ├── analytics.go            # API: report, stats, batch, popular
│   │   ├── health.go               # API: health check
│   │   └── middleware.go           # CORS, logging, recovery, real-ip
│   ├── model/analytics.go          # Domain types
│   ├── store/
│   │   ├── store.go                # Repository interface
│   │   └── sqlite.go              # SQLite implementation + embedded migration
│   └── service/analytics.go        # Business logic: dedup, bot filter, rate limit
├── migrations/001_init.sql         # Schema reference (embedded in binary)
├── sdk/blog-helper.js              # Frontend JS SDK (zero-dependency)
├── deploy/
│   ├── blog-helper.service         # systemd unit file
│   └── nginx-blog-helper.conf     # nginx reverse proxy config
└── Makefile
```

## Quick Start

```bash
# Run locally
make run

# Build for Linux server
make build-linux

# Deploy (customize SERVER in Makefile)
make deploy
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/analytics/report` | Report page view + return updated PV/UV (body: `site_id`, `page_slug`, ...) |
| `GET` | `/api/v1/analytics/stats?slug=...&site_id=...` | Get single page stats |
| `POST` | `/api/v1/analytics/stats/batch` | Batch get stats for multiple pages (body: `site_id`, `slugs`) |
| `GET` | `/api/v1/analytics/popular?limit=10&period=30d&site_id=...` | Popular articles ranking |
| `GET` | `/api/v1/health` | Health check |

## Frontend SDK

Zero-config — just add one `<script>` tag:

```html
<script src="asset/js/blog-helper.js" defer></script>
```

The SDK auto-detects the current domain (`site_id`), API base URL, and page type (list/post), reports PV, and renders stats. Multi-site ready out of the box.

Override defaults if needed:

```html
<script>
window.BlogHelperConfig = {
  apiBase: "https://custom-domain.com/api/v1/analytics",
  selectors: { postContainer: "article.post", listItems: ".post-item" },
  features: { showPopular: true, popularLimit: 8 },
};
</script>
```

## Tech Stack

- **Backend**: Go (stdlib `net/http`) + SQLite (`modernc.org/sqlite`, pure Go, no CGO)
- **Frontend**: Vanilla JS, zero dependencies
- **Deploy**: systemd + nginx reverse proxy

## Configuration

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `-addr` | `BH_ADDR` | `127.0.0.1:9001` | Listen address |
| `-db` | `BH_DB` | `./data/blog-helper.db` | SQLite database path |
| `-allowed-origins` | `BH_ALLOWED_ORIGINS` | `https://your-site.com` | CORS origins (comma-separated) |
