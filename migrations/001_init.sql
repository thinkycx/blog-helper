-- Blog Helper: Schema v2 (multi-site support)
-- Reference only — actual DDL is embedded as const in internal/store/sqlite.go.
-- All tables include site_id to isolate data between different sites.

-- Raw event log: one row per page view, supports future re-aggregation
CREATE TABLE IF NOT EXISTS page_views (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       TEXT    NOT NULL DEFAULT '',  -- Hostname, e.g. "example.com"
    page_slug     TEXT    NOT NULL,             -- URL path, e.g. "/2024/01/my-post"
    page_title    TEXT    NOT NULL DEFAULT '',   -- Page title (for popular articles display)
    fingerprint   TEXT    NOT NULL DEFAULT '',   -- Browser fingerprint hash (for UV dedup)
    ip            TEXT    NOT NULL DEFAULT '',   -- Client IP
    user_agent    TEXT    NOT NULL DEFAULT '',
    referrer      TEXT    NOT NULL DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pv_site_slug       ON page_views(site_id, page_slug);
CREATE INDEX IF NOT EXISTS idx_pv_site_slug_fp    ON page_views(site_id, page_slug, fingerprint);
CREATE INDEX IF NOT EXISTS idx_pv_site_created    ON page_views(site_id, created_at);

-- Materialized aggregate cache: counter cache pattern for fast reads
CREATE TABLE IF NOT EXISTS page_stats (
    site_id       TEXT    NOT NULL DEFAULT '',
    page_slug     TEXT    NOT NULL,
    page_title    TEXT    NOT NULL DEFAULT '',
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    updated_at    DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (site_id, page_slug)
);

-- Daily rollup: pre-aggregated per page per day (for future trend charts)
CREATE TABLE IF NOT EXISTS daily_stats (
    site_id       TEXT    NOT NULL DEFAULT '',
    page_slug     TEXT    NOT NULL,
    date          TEXT    NOT NULL,              -- "2024-01-15"
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, page_slug, date)
);

-- Site-wide daily totals (for future dashboard overview)
CREATE TABLE IF NOT EXISTS site_daily_stats (
    site_id       TEXT    NOT NULL DEFAULT '',
    date          TEXT    NOT NULL,              -- "2024-01-15"
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, date)
);
