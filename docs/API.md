# Blog Helper API Reference

Base path: `/api/v1`. All responses: `{"ok":true,"data":...}` or `{"ok":false,"error":{"code":"...","message":"..."}}`.

Authentication: dashboard endpoints require a session cookie (login at `/api/v1/dashboard`).

---

### Public (SDK-facing)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/analytics/report` | Report a page view, returns updated PV/UV |
| `GET` | `/analytics/stats?slug=...&site_id=...` | Stats for a single page |
| `POST` | `/analytics/stats/batch` | Batch stats (`{"site_id":"...","slugs":[...]}`) |
| `GET` | `/analytics/popular?limit=10&period=all&site_id=...&prefix=/&exclude=/ai-notes/` | Popular articles ranking |

### Comments & Reactions (public)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/comments/config?site_id=...` | Comment mode for the site |
| `GET` | `/comments?slug=...&site_id=...` | Get comments for a page |
| `POST` | `/comments/post` | Post a comment (PoW required). Optional `anchor` field (JSON string) turns it into an inline comment — see [Inline Comment Anchor](#inline-comment-anchor) |
| `POST` | `/comments/count` | Batch comment counts |
| `GET` | `/comments/challenge?site_id=...` | Get PoW challenge |
| `POST` | `/comments/react` | React (emoji) to a comment |
| `GET` | `/comments/recent?site_id=...&limit=5` | Recent comments (sidebar) |
| `GET` | `/comments/hot?site_id=...&limit=5` | Hot comments by reaction count |
| `GET` | `/commenter/lookup?token=...` | Look up commenter by token |
| `POST` | `/commenter/profile` | Update commenter profile |
| `POST` | `/page/react` | React (heart) to a page |
| `GET` | `/page/reactions?slug=...&site_id=...` | Get page reaction counts |
| `POST` | `/page/reactions/batch` | Batch page reactions (`{"site_id":"...","slugs":[...]}`) |

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

# Post an inline (text-anchored) comment — anchor is a JSON string, optional
curl -X POST http://localhost:9001/api/v1/comments/post \
  -H "Content-Type: application/json" \
  -d '{"page_slug":"/2024/01/hello","email":"a@b.com","nickname":"Alice","content":"great passage","anchor":"{\"exact\":\"a great sentence\",\"prefix\":\"...\",\"suffix\":\"...\",\"start\":10,\"end\":24}"}'
```

Error format: `{"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many requests"}}`

## Inline Comment Anchor

Inline (text-anchored) comments carry an `anchor` field on POST and in GET responses —
a JSON string in the W3C Web Annotation TextQuoteSelector style:

```json
{
  "exact":  "the selected passage",
  "prefix": "up to 32 chars before the passage",
  "suffix": "up to 32 chars after the passage",
  "start":  190,
  "end":    210
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `exact` | string | yes | the selected text, ≤1024 chars |
| `prefix` | string | no | context before, ≤128 chars (server truncates) |
| `suffix` | string | no | context after, ≤128 chars (server truncates) |
| `start` / `end` | int | no | character offsets in the article body text |

- Whole anchor payload is capped at 2KB; unknown fields are dropped.
- Empty / missing `anchor` = a regular whole-page comment (fully backward compatible).
- Resolution order on render: position + exact verification → prefix+exact+suffix search → exact search; all failed = quote-only display.
- Deep link format: `page.html#bh-{start}-{end}`.
