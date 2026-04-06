-- Blog Analytics: Initial Schema
-- Tracks page views (PV) and unique visitors (UV) for static blog posts.

-- Raw event log: one row per page view, supports future re-aggregation
CREATE TABLE IF NOT EXISTS page_views (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    page_slug     TEXT    NOT NULL,            -- URL path, e.g. "/2024/01/my-post"
    page_title    TEXT    NOT NULL DEFAULT '',  -- Page title (for popular articles display)
    fingerprint   TEXT    NOT NULL DEFAULT '',  -- Browser fingerprint hash (for UV dedup)
    ip            TEXT    NOT NULL DEFAULT '',  -- Client IP
    user_agent    TEXT    NOT NULL DEFAULT '',
    referrer      TEXT    NOT NULL DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pv_slug       ON page_views(page_slug);
CREATE INDEX IF NOT EXISTS idx_pv_slug_fp    ON page_views(page_slug, fingerprint);
CREATE INDEX IF NOT EXISTS idx_pv_created    ON page_views(created_at);

-- Materialized aggregate cache: counter cache pattern for fast reads
CREATE TABLE IF NOT EXISTS page_stats (
    page_slug     TEXT PRIMARY KEY,
    page_title    TEXT    NOT NULL DEFAULT '',
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    updated_at    DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Daily rollup: pre-aggregated per page per day (for future trend charts)
CREATE TABLE IF NOT EXISTS daily_stats (
    page_slug     TEXT    NOT NULL,
    date          TEXT    NOT NULL,            -- "2024-01-15"
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (page_slug, date)
);

-- Site-wide daily totals (for future dashboard overview)
CREATE TABLE IF NOT EXISTS site_daily_stats (
    date          TEXT PRIMARY KEY,            -- "2024-01-15"
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0
);
