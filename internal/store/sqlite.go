package store

import (
	"context"
	"database/sql"
	"fmt"
	neturl "net/url"
	"strings"
	"time"

	"github.com/thinkycx/blog-helper/internal/model"

	_ "modernc.org/sqlite"
)

// initSQL contains the database migration SQL (v2: multi-site support).
// All tables include site_id to isolate data between different sites.
// Kept as a const to avoid go:embed path issues and ensure the binary is self-contained.
const initSQL = `
CREATE TABLE IF NOT EXISTS page_views (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       TEXT    NOT NULL DEFAULT '',
    page_slug     TEXT    NOT NULL,
    page_title    TEXT    NOT NULL DEFAULT '',
    fingerprint   TEXT    NOT NULL DEFAULT '',
    ip            TEXT    NOT NULL DEFAULT '',
    user_agent    TEXT    NOT NULL DEFAULT '',
    referrer      TEXT    NOT NULL DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_site_slug       ON page_views(site_id, page_slug);
CREATE INDEX IF NOT EXISTS idx_pv_site_slug_fp    ON page_views(site_id, page_slug, fingerprint);
CREATE INDEX IF NOT EXISTS idx_pv_site_created    ON page_views(site_id, created_at);

CREATE TABLE IF NOT EXISTS page_stats (
    site_id       TEXT    NOT NULL DEFAULT '',
    page_slug     TEXT    NOT NULL,
    page_title    TEXT    NOT NULL DEFAULT '',
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    updated_at    DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (site_id, page_slug)
);

CREATE TABLE IF NOT EXISTS daily_stats (
    site_id       TEXT    NOT NULL DEFAULT '',
    page_slug     TEXT    NOT NULL,
    date          TEXT    NOT NULL,
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, page_slug, date)
);

CREATE TABLE IF NOT EXISTS site_daily_stats (
    site_id       TEXT    NOT NULL DEFAULT '',
    date          TEXT    NOT NULL,
    pv_count      INTEGER NOT NULL DEFAULT 0,
    uv_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, date)
);

-- Comment system tables
CREATE TABLE IF NOT EXISTS commenters (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    nickname      TEXT    NOT NULL,
    avatar_seed   TEXT    NOT NULL DEFAULT '',
    blog_url      TEXT    NOT NULL DEFAULT '',
    bio           TEXT    NOT NULL DEFAULT '',
    reg_ip        TEXT    NOT NULL DEFAULT '',
    reg_ua        TEXT    NOT NULL DEFAULT '',
    reg_fp        TEXT    NOT NULL DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at    DATETIME NOT NULL DEFAULT (datetime('now')),
    last_seen_at  DATETIME
);

CREATE TABLE IF NOT EXISTS commenter_tokens (
    token         TEXT    PRIMARY KEY,
    commenter_id  INTEGER NOT NULL,
    site_id       TEXT    NOT NULL DEFAULT '',
    device_info   TEXT    NOT NULL DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (commenter_id) REFERENCES commenters(id)
);
CREATE INDEX IF NOT EXISTS idx_ct_commenter ON commenter_tokens(commenter_id);

CREATE TABLE IF NOT EXISTS comments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       TEXT    NOT NULL DEFAULT '',
    page_slug     TEXT    NOT NULL,
    commenter_id  INTEGER NOT NULL,
    parent_id     INTEGER,
    content       TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    ip            TEXT    NOT NULL DEFAULT '',
    user_agent    TEXT    NOT NULL DEFAULT '',
    fingerprint   TEXT    NOT NULL DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (commenter_id) REFERENCES commenters(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_site_slug   ON comments(site_id, page_slug);
CREATE INDEX IF NOT EXISTS idx_comments_status      ON comments(site_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_commenter   ON comments(commenter_id);

CREATE TABLE IF NOT EXISTS comment_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id  INTEGER NOT NULL REFERENCES comments(id),
    emoji       TEXT    NOT NULL,
    fingerprint TEXT    NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
    UNIQUE(comment_id, emoji, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_reactions_comment ON comment_reactions(comment_id);

CREATE TABLE IF NOT EXISTS page_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     TEXT    NOT NULL,
    page_slug   TEXT    NOT NULL,
    emoji       TEXT    NOT NULL,
    fingerprint TEXT    NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
    UNIQUE(site_id, page_slug, emoji, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_page_reactions_slug ON page_reactions(site_id, page_slug);
`


// SQLiteStore implements Store using SQLite.
type SQLiteStore struct {
	db *sql.DB
}

// NewSQLiteStore opens or creates a SQLite database and runs migrations.
func NewSQLiteStore(dbPath string) (*SQLiteStore, error) {
	// Enable WAL mode and other pragmas for better concurrent read performance
	dsn := fmt.Sprintf("%s?_pragma=journal_mode(wal)&_pragma=busy_timeout(10000)&_pragma=synchronous(normal)&_pragma=foreign_keys(on)", dbPath)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// Connection pool: WAL mode allows concurrent reads, so allow multiple conns.
	// Writes will serialize via SQLite's internal locking + busy_timeout.
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(0) // keep alive forever

	// Run migrations
	if _, err := db.ExecContext(context.Background(), initSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	// Ensure admin commenter placeholder (id=0) exists for admin replies.
	db.ExecContext(context.Background(),
		`INSERT OR IGNORE INTO commenters (id, email, nickname, avatar_seed) VALUES (0, 'admin@system', '作者', 'admin')`)

	// Attempt v1→v2 migration: add site_id columns to existing tables.
	// These will fail silently if the column already exists (fresh install) or succeed on upgrade.
	migrateV1ToV2(db)

	// Fix created_at format: Go's time.Time serializes as "2006-01-02 15:04:05.999999 +0000 UTC"
	// which SQLite's strftime() cannot parse. Normalize to "YYYY-MM-DD HH:MM:SS".
	db.Exec(`UPDATE page_views SET created_at = SUBSTR(created_at, 1, 19) WHERE LENGTH(created_at) > 19`)

	// Recalculate UV counts: previously excluded empty fingerprints, now include them.
	db.Exec(`UPDATE daily_stats SET uv_count = (
		SELECT COUNT(DISTINCT pv.fingerprint) FROM page_views pv
		WHERE pv.site_id = daily_stats.site_id AND pv.page_slug = daily_stats.page_slug
		  AND date(pv.created_at) = daily_stats.date
	) WHERE uv_count = 0 AND pv_count > 0`)
	db.Exec(`UPDATE site_daily_stats SET uv_count = (
		SELECT COUNT(DISTINCT pv.fingerprint) FROM page_views pv
		WHERE pv.site_id = site_daily_stats.site_id AND date(pv.created_at) = site_daily_stats.date
	) WHERE uv_count = 0 AND pv_count > 0`)
	db.Exec(`UPDATE page_stats SET uv_count = (
		SELECT COUNT(DISTINCT pv.fingerprint) FROM page_views pv
		WHERE pv.site_id = page_stats.site_id AND pv.page_slug = page_stats.page_slug
	) WHERE uv_count = 0 AND pv_count > 0`)

	return &SQLiteStore{db: db}, nil
}

// migrateV1ToV2 handles upgrading from the original schema (no site_id) to v2.
// For fresh installs, the tables are already created with site_id, so this is a no-op.
func migrateV1ToV2(db *sql.DB) {
	// Try adding site_id to each table. If the column already exists, ALTER TABLE will fail — that's fine.
	alterStmts := []string{
		`ALTER TABLE page_views ADD COLUMN site_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE daily_stats ADD COLUMN site_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE site_daily_stats ADD COLUMN site_id TEXT NOT NULL DEFAULT ''`,
	}
	for _, stmt := range alterStmts {
		db.Exec(stmt) // ignore errors (column may already exist)
	}

	// For page_stats, we need to handle the PK change. Since the original PK was just page_slug,
	// and the new PK is (site_id, page_slug), we handle this by:
	// 1. Adding the column if it doesn't exist (existing data gets site_id='')
	// 2. The new indexes will be created by initSQL if they don't exist
	db.Exec(`ALTER TABLE page_stats ADD COLUMN site_id TEXT NOT NULL DEFAULT ''`)

	// Create new indexes for existing tables (safe: IF NOT EXISTS)
	db.Exec(`CREATE INDEX IF NOT EXISTS idx_pv_site_slug ON page_views(site_id, page_slug)`)
	db.Exec(`CREATE INDEX IF NOT EXISTS idx_pv_site_slug_fp ON page_views(site_id, page_slug, fingerprint)`)
	db.Exec(`CREATE INDEX IF NOT EXISTS idx_pv_site_created ON page_views(site_id, created_at)`)
}

// RecordPageView inserts a page view event and updates all aggregate tables atomically.
func (s *SQLiteStore) RecordPageView(ctx context.Context, pv *model.PageView) (*model.PageStats, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	nowStr := now.Format("2006-01-02 15:04:05")

	// 1. Insert raw page view event
	_, err = tx.ExecContext(ctx, `
		INSERT INTO page_views (site_id, page_slug, page_title, fingerprint, ip, user_agent, referrer, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		pv.SiteID, pv.PageSlug, pv.PageTitle, pv.Fingerprint, pv.IP, pv.UserAgent, pv.Referrer, nowStr)
	if err != nil {
		return nil, fmt.Errorf("insert page_view: %w", err)
	}

	// 2. Upsert page_stats (counter cache)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO page_stats (site_id, page_slug, page_title, pv_count, uv_count, updated_at)
		VALUES (?, ?, ?, 1, 1, ?)
		ON CONFLICT(site_id, page_slug) DO UPDATE SET
			page_title = CASE WHEN excluded.page_title != '' THEN excluded.page_title ELSE page_stats.page_title END,
			pv_count = pv_count + 1,
			uv_count = (SELECT COUNT(DISTINCT fingerprint) FROM page_views WHERE site_id = ? AND page_slug = ?),
			updated_at = ?`,
		pv.SiteID, pv.PageSlug, pv.PageTitle, now, pv.SiteID, pv.PageSlug, now)
	if err != nil {
		return nil, fmt.Errorf("upsert page_stats: %w", err)
	}

	// 3. Upsert daily_stats
	_, err = tx.ExecContext(ctx, `
		INSERT INTO daily_stats (site_id, page_slug, date, pv_count, uv_count)
		VALUES (?, ?, ?, 1, 1)
		ON CONFLICT(site_id, page_slug, date) DO UPDATE SET
			pv_count = pv_count + 1,
			uv_count = (SELECT COUNT(DISTINCT fingerprint) FROM page_views
				WHERE site_id = ? AND page_slug = ? AND date(created_at) = ?)`,
		pv.SiteID, pv.PageSlug, today, pv.SiteID, pv.PageSlug, today)
	if err != nil {
		return nil, fmt.Errorf("upsert daily_stats: %w", err)
	}

	// 4. Upsert site_daily_stats
	_, err = tx.ExecContext(ctx, `
		INSERT INTO site_daily_stats (site_id, date, pv_count, uv_count)
		VALUES (?, ?, 1, 1)
		ON CONFLICT(site_id, date) DO UPDATE SET
			pv_count = pv_count + 1,
			uv_count = (SELECT COUNT(DISTINCT fingerprint) FROM page_views
				WHERE site_id = ? AND date(created_at) = ?)`,
		pv.SiteID, today, pv.SiteID, today)
	if err != nil {
		return nil, fmt.Errorf("upsert site_daily_stats: %w", err)
	}

	// 5. Read updated stats to return
	var stats model.PageStats
	err = tx.QueryRowContext(ctx, `
		SELECT site_id, page_slug, page_title, pv_count, uv_count FROM page_stats
		WHERE site_id = ? AND page_slug = ?`,
		pv.SiteID, pv.PageSlug).Scan(&stats.SiteID, &stats.PageSlug, &stats.PageTitle, &stats.PVCount, &stats.UVCount)
	if err != nil {
		return nil, fmt.Errorf("read updated stats: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &stats, nil
}

// GetPageStats returns aggregated stats for a single page slug within a site.
func (s *SQLiteStore) GetPageStats(ctx context.Context, siteID, slug string) (*model.PageStats, error) {
	var stats model.PageStats
	err := s.db.QueryRowContext(ctx, `
		SELECT site_id, page_slug, page_title, pv_count, uv_count FROM page_stats
		WHERE site_id = ? AND page_slug = ?`,
		siteID, slug).Scan(&stats.SiteID, &stats.PageSlug, &stats.PageTitle, &stats.PVCount, &stats.UVCount)
	if err == sql.ErrNoRows {
		return &model.PageStats{SiteID: siteID, PageSlug: slug, PVCount: 0, UVCount: 0}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get page stats: %w", err)
	}
	return &stats, nil
}

// BatchGetPageStats returns stats for multiple slugs in a single query within a site.
func (s *SQLiteStore) BatchGetPageStats(ctx context.Context, siteID string, slugs []string) (map[string]*model.PageStats, error) {
	if len(slugs) == 0 {
		return make(map[string]*model.PageStats), nil
	}

	// Build placeholders: ?, ?, ?
	placeholders := make([]string, len(slugs))
	args := make([]interface{}, 0, len(slugs)+1)
	args = append(args, siteID)
	for i, slug := range slugs {
		placeholders[i] = "?"
		args = append(args, slug)
	}

	query := fmt.Sprintf(`
		SELECT site_id, page_slug, page_title, pv_count, uv_count
		FROM page_stats
		WHERE site_id = ? AND page_slug IN (%s)`, strings.Join(placeholders, ","))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("batch get page stats: %w", err)
	}
	defer rows.Close()

	result := make(map[string]*model.PageStats, len(slugs))
	for rows.Next() {
		var stats model.PageStats
		if err := rows.Scan(&stats.SiteID, &stats.PageSlug, &stats.PageTitle, &stats.PVCount, &stats.UVCount); err != nil {
			return nil, fmt.Errorf("scan page stats: %w", err)
		}
		result[stats.PageSlug] = &stats
	}

	// Fill in missing slugs with zero stats
	for _, slug := range slugs {
		if _, ok := result[slug]; !ok {
			result[slug] = &model.PageStats{SiteID: siteID, PageSlug: slug, PVCount: 0, UVCount: 0}
		}
	}

	return result, nil
}

// GetPopularArticles returns top N articles by PV within a time period for a site.
func (s *SQLiteStore) GetPopularArticles(ctx context.Context, siteID string, limit int, period string) ([]*model.PopularArticle, error) {
	var query string
	var args []interface{}

	switch period {
	case "7d":
		query = `
			SELECT page_slug, SUM(pv_count) as total_pv
			FROM daily_stats
			WHERE site_id = ? AND date >= date('now', '-7 days')
			GROUP BY page_slug
			ORDER BY total_pv DESC
			LIMIT ?`
		args = []interface{}{siteID, limit}
	case "30d":
		query = `
			SELECT page_slug, SUM(pv_count) as total_pv
			FROM daily_stats
			WHERE site_id = ? AND date >= date('now', '-30 days')
			GROUP BY page_slug
			ORDER BY total_pv DESC
			LIMIT ?`
		args = []interface{}{siteID, limit}
	default: // "all"
		query = `
			SELECT page_slug, pv_count as total_pv
			FROM page_stats
			WHERE site_id = ?
			ORDER BY pv_count DESC
			LIMIT ?`
		args = []interface{}{siteID, limit}
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get popular articles: %w", err)
	}
	defer rows.Close()

	var articles []*model.PopularArticle
	slugs := make([]string, 0)

	for rows.Next() {
		var a model.PopularArticle
		if err := rows.Scan(&a.PageSlug, &a.PVCount); err != nil {
			return nil, fmt.Errorf("scan popular article: %w", err)
		}
		articles = append(articles, &a)
		slugs = append(slugs, a.PageSlug)
	}

	// Fetch titles from page_stats
	if len(slugs) > 0 {
		titleMap, err := s.fetchTitles(ctx, siteID, slugs)
		if err != nil {
			return nil, err
		}
		for _, a := range articles {
			if title, ok := titleMap[a.PageSlug]; ok {
				a.PageTitle = title
			}
		}
	}

	return articles, nil
}

// fetchTitles retrieves page titles from page_stats for given slugs within a site.
func (s *SQLiteStore) fetchTitles(ctx context.Context, siteID string, slugs []string) (map[string]string, error) {
	placeholders := make([]string, len(slugs))
	args := make([]interface{}, 0, len(slugs)+1)
	args = append(args, siteID)
	for i, slug := range slugs {
		placeholders[i] = "?"
		args = append(args, slug)
	}

	query := fmt.Sprintf(`SELECT page_slug, page_title FROM page_stats WHERE site_id = ? AND page_slug IN (%s)`,
		strings.Join(placeholders, ","))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("fetch titles: %w", err)
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var slug, title string
		if err := rows.Scan(&slug, &title); err != nil {
			return nil, fmt.Errorf("scan title: %w", err)
		}
		result[slug] = title
	}
	return result, nil
}

// GetActiveVisitors returns the count of distinct fingerprints in the last N minutes.
func (s *SQLiteStore) GetActiveVisitors(ctx context.Context, siteID string, minutes int) (*model.ActiveVisitors, error) {
	var count int64
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT fingerprint)
		FROM page_views
		WHERE site_id = ? AND created_at >= datetime('now', ? || ' minutes') AND fingerprint != ''`,
		siteID, fmt.Sprintf("-%d", minutes)).Scan(&count)
	if err != nil {
		return nil, fmt.Errorf("get active visitors: %w", err)
	}
	return &model.ActiveVisitors{Count: count, Minutes: minutes}, nil
}

// GetSiteTrend returns site-wide daily PV/UV for the last N days, with gaps filled as zeros.
func (s *SQLiteStore) GetSiteTrend(ctx context.Context, siteID string, days int) ([]*model.SiteDailyStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT date, pv_count, uv_count
		FROM site_daily_stats
		WHERE site_id = ? AND date >= date('now', ? || ' days')
		ORDER BY date ASC`,
		siteID, fmt.Sprintf("-%d", days))
	if err != nil {
		return nil, fmt.Errorf("get site trend: %w", err)
	}
	defer rows.Close()

	// Collect query results into a map
	dataMap := make(map[string]*model.SiteDailyStat)
	for rows.Next() {
		var s model.SiteDailyStat
		if err := rows.Scan(&s.Date, &s.PVCount, &s.UVCount); err != nil {
			return nil, fmt.Errorf("scan site trend: %w", err)
		}
		dataMap[s.Date] = &s
	}

	// Fill date gaps with zeros
	now := time.Now().UTC()
	result := make([]*model.SiteDailyStat, 0, days)
	for i := days - 1; i >= 0; i-- {
		date := now.AddDate(0, 0, -i).Format("2006-01-02")
		if stat, ok := dataMap[date]; ok {
			result = append(result, stat)
		} else {
			result = append(result, &model.SiteDailyStat{Date: date, PVCount: 0, UVCount: 0})
		}
	}
	return result, nil
}

// GetTopReferrers returns the top N referrer domains within the last N days.
func (s *SQLiteStore) GetTopReferrers(ctx context.Context, siteID string, days int, limit int) ([]*model.ReferrerStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT referrer, COUNT(*) as cnt
		FROM page_views
		WHERE site_id = ? AND created_at >= datetime('now', ? || ' days')
		GROUP BY referrer
		ORDER BY cnt DESC`,
		siteID, fmt.Sprintf("-%d", days))
	if err != nil {
		return nil, fmt.Errorf("get top referrers: %w", err)
	}
	defer rows.Close()

	// Aggregate by domain in Go (more robust than SQL string surgery)
	domainCounts := make(map[string]int64)
	for rows.Next() {
		var referrer string
		var count int64
		if err := rows.Scan(&referrer, &count); err != nil {
			return nil, fmt.Errorf("scan referrer: %w", err)
		}
		domain := extractDomain(referrer)
		domainCounts[domain] += count
	}

	// Sort by count descending
	type kv struct {
		domain string
		count  int64
	}
	sorted := make([]kv, 0, len(domainCounts))
	for d, c := range domainCounts {
		sorted = append(sorted, kv{d, c})
	}
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j].count > sorted[i].count {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}

	// Limit results
	if len(sorted) > limit {
		sorted = sorted[:limit]
	}
	result := make([]*model.ReferrerStat, len(sorted))
	for i, s := range sorted {
		result[i] = &model.ReferrerStat{Domain: s.domain, Count: s.count}
	}
	return result, nil
}

// GetPageTrend returns per-page daily PV/UV for the last N days, with gaps filled as zeros.
func (s *SQLiteStore) GetPageTrend(ctx context.Context, siteID, slug string, days int) ([]*model.SiteDailyStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT date, pv_count, uv_count
		FROM daily_stats
		WHERE site_id = ? AND page_slug = ? AND date >= date('now', ? || ' days')
		ORDER BY date ASC`,
		siteID, slug, fmt.Sprintf("-%d", days))
	if err != nil {
		return nil, fmt.Errorf("get page trend: %w", err)
	}
	defer rows.Close()

	dataMap := make(map[string]*model.SiteDailyStat)
	for rows.Next() {
		var s model.SiteDailyStat
		if err := rows.Scan(&s.Date, &s.PVCount, &s.UVCount); err != nil {
			return nil, fmt.Errorf("scan page trend: %w", err)
		}
		dataMap[s.Date] = &s
	}

	now := time.Now().UTC()
	result := make([]*model.SiteDailyStat, 0, days)
	for i := days - 1; i >= 0; i-- {
		date := now.AddDate(0, 0, -i).Format("2006-01-02")
		if stat, ok := dataMap[date]; ok {
			result = append(result, stat)
		} else {
			result = append(result, &model.SiteDailyStat{Date: date, PVCount: 0, UVCount: 0})
		}
	}
	return result, nil
}

// GetPlatformStats returns user-agent platform distribution for the last N days.
func (s *SQLiteStore) GetPlatformStats(ctx context.Context, siteID string, days int) ([]*model.PlatformStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT user_agent FROM page_views
		WHERE site_id = ? AND created_at >= datetime('now', ? || ' days')`,
		siteID, fmt.Sprintf("-%d", days))
	if err != nil {
		return nil, fmt.Errorf("get platform stats: %w", err)
	}
	defer rows.Close()

	counts := make(map[string]int64)
	for rows.Next() {
		var ua string
		if err := rows.Scan(&ua); err != nil {
			return nil, fmt.Errorf("scan ua: %w", err)
		}
		p := classifyPlatform(ua)
		counts[p]++
	}

	// Sort by count descending
	order := []string{"Windows", "macOS", "Linux", "Android", "iOS", "Other"}
	result := make([]*model.PlatformStat, 0)
	for _, name := range order {
		if c, ok := counts[name]; ok {
			result = append(result, &model.PlatformStat{Platform: name, Count: c})
			delete(counts, name)
		}
	}
	// Any remaining
	for name, c := range counts {
		result = append(result, &model.PlatformStat{Platform: name, Count: c})
	}
	return result, nil
}

// classifyPlatform returns a platform name from a user-agent string.
func classifyPlatform(ua string) string {
	lower := strings.ToLower(ua)
	switch {
	case strings.Contains(lower, "iphone") || strings.Contains(lower, "ipad"):
		return "iOS"
	case strings.Contains(lower, "android"):
		return "Android"
	case strings.Contains(lower, "macintosh") || strings.Contains(lower, "mac os"):
		return "macOS"
	case strings.Contains(lower, "windows"):
		return "Windows"
	case strings.Contains(lower, "linux"):
		return "Linux"
	default:
		return "Other"
	}
}

// GetRecentTrend returns PV/UV trend for sub-daily periods by querying raw page_views.
func (s *SQLiteStore) GetRecentTrend(ctx context.Context, siteID, slug, period string) ([]*model.SiteDailyStat, error) {
	var sqlInterval string
	var bucketSQL string
	var step time.Duration

	switch period {
	case "1h":
		sqlInterval = "-1 hour"
		bucketSQL = `strftime('%Y-%m-%d %H:', created_at) || SUBSTR('00' || ((CAST(strftime('%M', created_at) AS INTEGER) / 5) * 5), -2)`
		step = 5 * time.Minute
	case "6h":
		sqlInterval = "-6 hours"
		bucketSQL = `strftime('%Y-%m-%d %H:', created_at) || CASE WHEN CAST(strftime('%M', created_at) AS INTEGER) < 30 THEN '00' ELSE '30' END`
		step = 30 * time.Minute
	case "1d":
		sqlInterval = "-24 hours"
		bucketSQL = `strftime('%Y-%m-%d %H:00', created_at)`
		step = time.Hour
	default:
		return nil, fmt.Errorf("unsupported period: %s", period)
	}

	slugClause := ""
	args := []interface{}{siteID}
	if slug != "" {
		slugClause = " AND page_slug = ?"
		args = append(args, slug)
	}
	args = append(args, sqlInterval)

	query := fmt.Sprintf(`
		SELECT %s AS bucket, COUNT(*) AS pv, COUNT(DISTINCT fingerprint) AS uv
		FROM page_views
		WHERE site_id = ?%s AND created_at >= datetime('now', ?)
		GROUP BY bucket
		ORDER BY bucket ASC`, bucketSQL, slugClause)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get recent trend: %w", err)
	}
	defer rows.Close()

	dataMap := make(map[string]*model.SiteDailyStat)
	for rows.Next() {
		var stat model.SiteDailyStat
		if err := rows.Scan(&stat.Date, &stat.PVCount, &stat.UVCount); err != nil {
			return nil, fmt.Errorf("scan recent trend: %w", err)
		}
		dataMap[stat.Date] = &stat
	}

	// Fill time gaps
	now := time.Now().UTC()
	var dur time.Duration
	switch period {
	case "1h":
		dur = time.Hour
	case "6h":
		dur = 6 * time.Hour
	case "1d":
		dur = 24 * time.Hour
	}
	start := now.Add(-dur).Truncate(step)
	end := now.Truncate(step)
	result := make([]*model.SiteDailyStat, 0)
	for t := start; !t.After(end); t = t.Add(step) {
		key := t.Format("2006-01-02 15:04")
		if stat, ok := dataMap[key]; ok {
			result = append(result, stat)
		} else {
			result = append(result, &model.SiteDailyStat{Date: key, PVCount: 0, UVCount: 0})
		}
	}
	return result, nil
}

// GetPageReferrers returns top referrer domains for a specific page within the last N days.
func (s *SQLiteStore) GetPageReferrers(ctx context.Context, siteID, slug string, days, limit int) ([]*model.ReferrerStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT referrer, COUNT(*) as cnt
		FROM page_views
		WHERE site_id = ? AND page_slug = ? AND created_at >= datetime('now', ? || ' days')
		GROUP BY referrer
		ORDER BY cnt DESC`,
		siteID, slug, fmt.Sprintf("-%d", days))
	if err != nil {
		return nil, fmt.Errorf("get page referrers: %w", err)
	}
	defer rows.Close()

	domainCounts := make(map[string]int64)
	for rows.Next() {
		var referrer string
		var count int64
		if err := rows.Scan(&referrer, &count); err != nil {
			return nil, fmt.Errorf("scan page referrer: %w", err)
		}
		domain := extractDomain(referrer)
		domainCounts[domain] += count
	}

	type kv struct {
		domain string
		count  int64
	}
	sorted := make([]kv, 0, len(domainCounts))
	for d, c := range domainCounts {
		sorted = append(sorted, kv{d, c})
	}
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j].count > sorted[i].count {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}

	if len(sorted) > limit {
		sorted = sorted[:limit]
	}
	result := make([]*model.ReferrerStat, len(sorted))
	for i, s := range sorted {
		result[i] = &model.ReferrerStat{Domain: s.domain, Count: s.count}
	}
	return result, nil
}

// GetRecentPageViews returns raw page view records with pagination.
func (s *SQLiteStore) GetRecentPageViews(ctx context.Context, siteID, slug string, days, limit, offset int) (*model.PageViewList, error) {
	var countQuery, dataQuery string
	var countArgs, dataArgs []interface{}

	where := "site_id = ?"
	args := []interface{}{siteID}
	if slug != "" {
		where += " AND page_slug = ?"
		args = append(args, slug)
	}
	if days > 0 {
		where += " AND created_at >= datetime('now', ?)"
		args = append(args, fmt.Sprintf("-%d days", days))
	}

	countQuery = "SELECT COUNT(*) FROM page_views WHERE " + where
	countArgs = args
	dataQuery = "SELECT id, page_slug, page_title, fingerprint, ip, user_agent, referrer, created_at FROM page_views WHERE " + where + " ORDER BY created_at DESC LIMIT ? OFFSET ?"
	dataArgs = append(append([]interface{}{}, args...), limit, offset)

	var total int64
	if err := s.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count page views: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, dataQuery, dataArgs...)
	if err != nil {
		return nil, fmt.Errorf("get recent page views: %w", err)
	}
	defer rows.Close()

	var records []*model.PageViewRecord
	for rows.Next() {
		var r model.PageViewRecord
		if err := rows.Scan(&r.ID, &r.PageSlug, &r.PageTitle, &r.Fingerprint, &r.IP, &r.UserAgent, &r.Referrer, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan page view: %w", err)
		}
		records = append(records, &r)
	}
	if records == nil {
		records = []*model.PageViewRecord{}
	}

	return &model.PageViewList{
		Records: records,
		Total:   total,
		Limit:   limit,
		Offset:  offset,
	}, nil
}

// GetRecentVisitors returns unique visitors ordered by last seen time.
func (s *SQLiteStore) GetRecentVisitors(ctx context.Context, siteID string, days, limit, offset int) ([]*model.VisitorSummary, error) {
	timeFilter := ""
	args := []interface{}{siteID}
	if days > 0 {
		timeFilter = fmt.Sprintf(" AND created_at >= datetime('now', '-%d days')", days)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT fingerprint, ip, user_agent, page_slug, page_title, created_at, cnt
		FROM (
			SELECT fingerprint, ip, user_agent, page_slug, page_title, created_at,
				COUNT(*) OVER (PARTITION BY fingerprint) as cnt,
				ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY created_at DESC) as rn
			FROM page_views
			WHERE site_id = ? AND fingerprint != ''`+timeFilter+`
		) sub
		WHERE rn = 1
		ORDER BY created_at DESC
		LIMIT ? OFFSET ?`,
		append(args, limit, offset)...)
	if err != nil {
		return nil, fmt.Errorf("get recent visitors: %w", err)
	}
	defer rows.Close()

	var visitors []*model.VisitorSummary
	for rows.Next() {
		var v model.VisitorSummary
		if err := rows.Scan(&v.Fingerprint, &v.LastIP, &v.LastUA, &v.LastPage, &v.LastPageTitle, &v.LastSeen, &v.PageViews); err != nil {
			return nil, fmt.Errorf("scan visitor: %w", err)
		}
		visitors = append(visitors, &v)
	}
	if visitors == nil {
		visitors = []*model.VisitorSummary{}
	}
	return visitors, nil
}

// SearchVisitor returns page view history for a specific fingerprint.
func (s *SQLiteStore) SearchVisitor(ctx context.Context, siteID, fingerprint string, days, limit, offset int) (*model.PageViewList, error) {
	where := "site_id = ? AND fingerprint = ?"
	args := []interface{}{siteID, fingerprint}
	if days > 0 {
		where += " AND created_at >= datetime('now', ?)"
		args = append(args, fmt.Sprintf("-%d days", days))
	}

	var total int64
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM page_views WHERE "+where, args...).Scan(&total)
	if err != nil {
		return nil, fmt.Errorf("count visitor views: %w", err)
	}

	rows, err := s.db.QueryContext(ctx,
		"SELECT id, page_slug, page_title, fingerprint, ip, user_agent, referrer, created_at FROM page_views WHERE "+where+" ORDER BY created_at DESC LIMIT ? OFFSET ?",
		append(append([]interface{}{}, args...), limit, offset)...)
	if err != nil {
		return nil, fmt.Errorf("search visitor: %w", err)
	}
	defer rows.Close()

	var records []*model.PageViewRecord
	for rows.Next() {
		var r model.PageViewRecord
		if err := rows.Scan(&r.ID, &r.PageSlug, &r.PageTitle, &r.Fingerprint, &r.IP, &r.UserAgent, &r.Referrer, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan visitor view: %w", err)
		}
		records = append(records, &r)
	}
	if records == nil {
		records = []*model.PageViewRecord{}
	}
	return &model.PageViewList{Records: records, Total: total, Limit: limit, Offset: offset}, nil
}

// extractDomain parses a referrer URL and returns just the hostname.
// GetPeriodSummary returns total PV and deduplicated UV for a given time period.
func (s *SQLiteStore) GetPeriodSummary(ctx context.Context, siteID, slug string, days int) (int64, int64, error) {
	where := "site_id = ?"
	args := []interface{}{siteID}
	if slug != "" {
		where += " AND page_slug = ?"
		args = append(args, slug)
	}
	if days > 0 {
		where += " AND created_at >= datetime('now', ?)"
		args = append(args, fmt.Sprintf("-%d days", days))
	}

	var pv, uv int64
	err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) AS pv, COUNT(DISTINCT fingerprint) AS uv FROM page_views WHERE "+where, args...,
	).Scan(&pv, &uv)
	if err != nil {
		return 0, 0, fmt.Errorf("get period summary: %w", err)
	}
	return pv, uv, nil
}

func (s *SQLiteStore) GetEngagementStats(ctx context.Context, siteID string, days int) (int64, int64, error) {
	// Total page reactions (likes)
	likeWhere := "site_id = ?"
	likeArgs := []interface{}{siteID}
	if days > 0 {
		likeWhere += " AND created_at >= datetime('now', ?)"
		likeArgs = append(likeArgs, fmt.Sprintf("-%d days", days))
	}
	var likes int64
	err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM page_reactions WHERE "+likeWhere, likeArgs...,
	).Scan(&likes)
	if err != nil {
		return 0, 0, fmt.Errorf("get engagement likes: %w", err)
	}

	// Distinct commenters (exclude admin id=0)
	cmtWhere := "c.site_id = ? AND c.commenter_id > 0"
	cmtArgs := []interface{}{siteID}
	if days > 0 {
		cmtWhere += " AND c.created_at >= datetime('now', ?)"
		cmtArgs = append(cmtArgs, fmt.Sprintf("-%d days", days))
	}
	var commenters int64
	err = s.db.QueryRowContext(ctx,
		"SELECT COUNT(DISTINCT c.commenter_id) FROM comments c WHERE "+cmtWhere, cmtArgs...,
	).Scan(&commenters)
	if err != nil {
		return 0, 0, fmt.Errorf("get engagement commenters: %w", err)
	}

	return likes, commenters, nil
}

func extractDomain(referrer string) string {
	if referrer == "" {
		return "direct"
	}
	// Add scheme if missing so url.Parse works
	raw := referrer
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	if u, err := neturl.Parse(raw); err == nil && u.Host != "" {
		return strings.ToLower(u.Host)
	}
	return strings.ToLower(referrer)
}

// --- Comment system Store methods ---

func (s *SQLiteStore) CreateCommenter(ctx context.Context, c *model.Commenter) (*model.Commenter, error) {
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO commenters (email, nickname, avatar_seed, blog_url, bio, reg_ip, reg_ua, reg_fp, created_at, updated_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.Email, c.Nickname, c.AvatarSeed, c.BlogURL, c.Bio,
		c.RegIP, c.RegUA, c.RegFP, now, now, now)
	if err != nil {
		return nil, fmt.Errorf("create commenter: %w", err)
	}
	id, _ := res.LastInsertId()
	c.ID = id
	return c, nil
}

func (s *SQLiteStore) GetCommenterByEmail(ctx context.Context, email string) (*model.Commenter, error) {
	var c model.Commenter
	var lastSeen sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, email, nickname, avatar_seed, blog_url, bio, reg_ip, reg_ua, reg_fp, created_at, updated_at, last_seen_at
		FROM commenters WHERE email = ?`, email).Scan(
		&c.ID, &c.Email, &c.Nickname, &c.AvatarSeed, &c.BlogURL, &c.Bio,
		&c.RegIP, &c.RegUA, &c.RegFP, &c.CreatedAt, &c.UpdatedAt, &lastSeen)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get commenter by email: %w", err)
	}
	if lastSeen.Valid {
		t, _ := time.Parse("2006-01-02 15:04:05", lastSeen.String)
		c.LastSeenAt = &t
	}
	return &c, nil
}

func (s *SQLiteStore) UpdateCommenterProfile(ctx context.Context, id int64, nickname, avatarSeed, blogURL, bio string) error {
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	_, err := s.db.ExecContext(ctx, `
		UPDATE commenters SET nickname = ?, avatar_seed = ?, blog_url = ?, bio = ?, updated_at = ?
		WHERE id = ?`, nickname, avatarSeed, blogURL, bio, now, id)
	if err != nil {
		return fmt.Errorf("update commenter profile: %w", err)
	}
	return nil
}

func (s *SQLiteStore) CreateCommenterToken(ctx context.Context, t *model.CommenterToken) error {
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO commenter_tokens (token, commenter_id, site_id, device_info, created_at)
		VALUES (?, ?, ?, ?, ?)`, t.Token, t.CommenterID, t.SiteID, t.DeviceInfo, now)
	if err != nil {
		return fmt.Errorf("create commenter token: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetCommenterByToken(ctx context.Context, token string) (*model.Commenter, error) {
	var c model.Commenter
	var lastSeen sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT c.id, c.email, c.nickname, c.avatar_seed, c.blog_url, c.bio,
		       c.reg_ip, c.reg_ua, c.reg_fp, c.created_at, c.updated_at, c.last_seen_at
		FROM commenters c
		JOIN commenter_tokens t ON t.commenter_id = c.id
		WHERE t.token = ?`, token).Scan(
		&c.ID, &c.Email, &c.Nickname, &c.AvatarSeed, &c.BlogURL, &c.Bio,
		&c.RegIP, &c.RegUA, &c.RegFP, &c.CreatedAt, &c.UpdatedAt, &lastSeen)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get commenter by token: %w", err)
	}
	if lastSeen.Valid {
		t, _ := time.Parse("2006-01-02 15:04:05", lastSeen.String)
		c.LastSeenAt = &t
	}
	return &c, nil
}

func (s *SQLiteStore) UpdateLastSeen(ctx context.Context, commenterID int64) error {
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	_, err := s.db.ExecContext(ctx, `UPDATE commenters SET last_seen_at = ? WHERE id = ?`, now, commenterID)
	if err != nil {
		return fmt.Errorf("update last seen: %w", err)
	}
	return nil
}

func (s *SQLiteStore) CreateComment(ctx context.Context, c *model.Comment) (*model.Comment, error) {
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO comments (site_id, page_slug, commenter_id, parent_id, content, status, ip, user_agent, fingerprint, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.SiteID, c.PageSlug, c.CommenterID, c.ParentID, c.Content, c.Status,
		c.IP, c.UserAgent, c.Fingerprint, now)
	if err != nil {
		return nil, fmt.Errorf("create comment: %w", err)
	}
	id, _ := res.LastInsertId()
	c.ID = id
	c.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", now)
	return c, nil
}

func (s *SQLiteStore) GetCommentsBySlug(ctx context.Context, siteID, slug string) ([]*model.CommentWithAuthor, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id, c.page_slug, c.commenter_id, c.parent_id, c.content, c.created_at,
		       u.id, u.nickname, u.avatar_seed, u.blog_url, u.bio
		FROM comments c
		LEFT JOIN commenters u ON u.id = c.commenter_id
		WHERE c.site_id = ? AND c.page_slug = ? AND c.status = 'approved'
		ORDER BY c.created_at ASC`, siteID, slug)
	if err != nil {
		return nil, fmt.Errorf("get comments by slug: %w", err)
	}
	defer rows.Close()

	var result []*model.CommentWithAuthor
	for rows.Next() {
		var cwa model.CommentWithAuthor
		var commenterID int64
		var parentID sql.NullInt64
		var authorID sql.NullInt64
		var authorNickname, authorAvatar, authorBlog, authorBio sql.NullString
		if err := rows.Scan(&cwa.ID, &cwa.PageSlug, &commenterID, &parentID, &cwa.Content, &cwa.CreatedAt,
			&authorID, &authorNickname, &authorAvatar, &authorBlog, &authorBio); err != nil {
			return nil, fmt.Errorf("scan comment: %w", err)
		}
		if parentID.Valid {
			pid := parentID.Int64
			cwa.ParentID = &pid
		}
		if authorID.Valid {
			cwa.Author = &model.CommenterPublic{
				ID: authorID.Int64, Nickname: authorNickname.String,
				AvatarSeed: authorAvatar.String, BlogURL: authorBlog.String, Bio: authorBio.String,
			}
		} else {
			// Admin comment (commenter_id=0)
			cwa.Author = &model.CommenterPublic{ID: 0, Nickname: "作者", AvatarSeed: "admin"}
		}
		result = append(result, &cwa)
	}
	if result == nil {
		result = []*model.CommentWithAuthor{}
	}
	return result, nil
}

func (s *SQLiteStore) GetPendingComments(ctx context.Context, siteID string) ([]*model.CommentWithAuthor, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id, c.site_id, c.page_slug, c.parent_id, c.content, c.status, c.ip, c.user_agent, c.fingerprint, c.created_at,
		       u.id, u.nickname, u.avatar_seed, u.blog_url, u.bio,
		       COALESCE(ps.page_title, '')
		FROM comments c
		LEFT JOIN commenters u ON u.id = c.commenter_id
		LEFT JOIN page_stats ps ON ps.site_id = c.site_id AND ps.page_slug = c.page_slug
		WHERE c.site_id = ? AND c.status = 'pending'
		ORDER BY c.created_at DESC`, siteID)
	if err != nil {
		return nil, fmt.Errorf("get pending comments: %w", err)
	}
	defer rows.Close()

	var result []*model.CommentWithAuthor
	for rows.Next() {
		var cwa model.CommentWithAuthor
		var parentID sql.NullInt64
		var authorID sql.NullInt64
		var authorNickname, authorAvatar, authorBlog, authorBio sql.NullString
		if err := rows.Scan(&cwa.ID, &cwa.SiteID, &cwa.PageSlug, &parentID, &cwa.Content, &cwa.Status,
			&cwa.IP, &cwa.UserAgent, &cwa.Fingerprint, &cwa.CreatedAt,
			&authorID, &authorNickname, &authorAvatar, &authorBlog, &authorBio,
			&cwa.PageTitle); err != nil {
			return nil, fmt.Errorf("scan pending comment: %w", err)
		}
		if parentID.Valid {
			pid := parentID.Int64
			cwa.ParentID = &pid
		}
		if authorID.Valid {
			cwa.Author = &model.CommenterPublic{
				ID: authorID.Int64, Nickname: authorNickname.String,
				AvatarSeed: authorAvatar.String, BlogURL: authorBlog.String, Bio: authorBio.String,
			}
		} else {
			cwa.Author = &model.CommenterPublic{ID: 0, Nickname: "作者", AvatarSeed: "admin"}
		}
		result = append(result, &cwa)
	}
	if result == nil {
		result = []*model.CommentWithAuthor{}
	}
	return result, nil
}

func (s *SQLiteStore) GetAllComments(ctx context.Context, siteID string, limit, offset int) ([]*model.CommentWithAuthor, int, error) {
	// Count total
	var total int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM comments WHERE site_id = ?`, siteID).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("count all comments: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id, c.site_id, c.page_slug, c.commenter_id, c.parent_id, c.content, c.status, c.ip, c.user_agent, c.fingerprint, c.created_at,
		       u.id, u.nickname, u.avatar_seed, u.blog_url, u.bio,
		       COALESCE(ps.page_title, '')
		FROM comments c
		LEFT JOIN commenters u ON u.id = c.commenter_id
		LEFT JOIN page_stats ps ON ps.site_id = c.site_id AND ps.page_slug = c.page_slug
		WHERE c.site_id = ?
		ORDER BY c.created_at DESC
		LIMIT ? OFFSET ?`, siteID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("get all comments: %w", err)
	}
	defer rows.Close()

	var result []*model.CommentWithAuthor
	for rows.Next() {
		var cwa model.CommentWithAuthor
		var commenterID int64
		var parentID sql.NullInt64
		var authorID sql.NullInt64
		var authorNickname, authorAvatar, authorBlog, authorBio sql.NullString
		if err := rows.Scan(&cwa.ID, &cwa.SiteID, &cwa.PageSlug, &commenterID, &parentID, &cwa.Content, &cwa.Status,
			&cwa.IP, &cwa.UserAgent, &cwa.Fingerprint, &cwa.CreatedAt,
			&authorID, &authorNickname, &authorAvatar, &authorBlog, &authorBio,
			&cwa.PageTitle); err != nil {
			return nil, 0, fmt.Errorf("scan comment: %w", err)
		}
		if parentID.Valid {
			pid := parentID.Int64
			cwa.ParentID = &pid
		}
		if authorID.Valid {
			cwa.Author = &model.CommenterPublic{
				ID: authorID.Int64, Nickname: authorNickname.String,
				AvatarSeed: authorAvatar.String, BlogURL: authorBlog.String, Bio: authorBio.String,
			}
		}
		result = append(result, &cwa)
	}
	if result == nil {
		result = []*model.CommentWithAuthor{}
	}
	return result, total, nil
}

func (s *SQLiteStore) GetAllCommenters(ctx context.Context, limit, offset int) ([]*model.Commenter, int, error) {
	var total int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM commenters WHERE id > 0`).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("count commenters: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id, email, nickname, avatar_seed, blog_url, bio, reg_ip, reg_ua, reg_fp, created_at, updated_at, last_seen_at
		FROM commenters WHERE id > 0
		ORDER BY id DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("get all commenters: %w", err)
	}
	defer rows.Close()

	var result []*model.Commenter
	for rows.Next() {
		var c model.Commenter
		if err := rows.Scan(&c.ID, &c.Email, &c.Nickname, &c.AvatarSeed, &c.BlogURL, &c.Bio,
			&c.RegIP, &c.RegUA, &c.RegFP, &c.CreatedAt, &c.UpdatedAt, &c.LastSeenAt); err != nil {
			return nil, 0, fmt.Errorf("scan commenter: %w", err)
		}
		result = append(result, &c)
	}
	if result == nil {
		result = []*model.Commenter{}
	}
	return result, total, nil
}

func (s *SQLiteStore) UpdateCommentStatus(ctx context.Context, id int64, status string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE comments SET status = ? WHERE id = ?`, status, id)
	if err != nil {
		return fmt.Errorf("update comment status: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteComment(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM comments WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete comment: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetCommentCounts(ctx context.Context, siteID string, slugs []string) ([]*model.CommentCountItem, error) {
	if len(slugs) == 0 {
		return []*model.CommentCountItem{}, nil
	}
	placeholders := make([]string, len(slugs))
	args := make([]interface{}, 0, len(slugs)+1)
	args = append(args, siteID)
	for i, slug := range slugs {
		placeholders[i] = "?"
		args = append(args, slug)
	}
	query := fmt.Sprintf(`
		SELECT page_slug, COUNT(*) FROM comments
		WHERE site_id = ? AND page_slug IN (%s) AND status = 'approved'
		GROUP BY page_slug`, strings.Join(placeholders, ","))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get comment counts: %w", err)
	}
	defer rows.Close()

	var result []*model.CommentCountItem
	for rows.Next() {
		var item model.CommentCountItem
		if err := rows.Scan(&item.PageSlug, &item.Count); err != nil {
			return nil, fmt.Errorf("scan comment count: %w", err)
		}
		result = append(result, &item)
	}
	if result == nil {
		result = []*model.CommentCountItem{}
	}
	return result, nil
}

// --- Reactions ---

func (s *SQLiteStore) AddReaction(ctx context.Context, commentID int64, emoji, fingerprint string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO comment_reactions (comment_id, emoji, fingerprint) VALUES (?, ?, ?)`,
		commentID, emoji, fingerprint)
	return err
}

func (s *SQLiteStore) RemoveReaction(ctx context.Context, commentID int64, emoji, fingerprint string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM comment_reactions WHERE comment_id = ? AND emoji = ? AND fingerprint = ?`,
		commentID, emoji, fingerprint)
	return err
}

func (s *SQLiteStore) GetReactionsByCommentIDs(ctx context.Context, commentIDs []int64) (map[int64][]model.ReactionCount, error) {
	if len(commentIDs) == 0 {
		return map[int64][]model.ReactionCount{}, nil
	}
	placeholders := make([]string, len(commentIDs))
	args := make([]interface{}, len(commentIDs))
	for i, id := range commentIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	query := `SELECT comment_id, emoji, COUNT(*) FROM comment_reactions
		WHERE comment_id IN (` + strings.Join(placeholders, ",") + `)
		GROUP BY comment_id, emoji ORDER BY COUNT(*) DESC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64][]model.ReactionCount{}
	for rows.Next() {
		var cid int64
		var rc model.ReactionCount
		if err := rows.Scan(&cid, &rc.Emoji, &rc.Count); err != nil {
			return nil, err
		}
		result[cid] = append(result[cid], rc)
	}
	return result, nil
}

func (s *SQLiteStore) GetUserReactions(ctx context.Context, commentIDs []int64, fingerprint string) (map[int64][]string, error) {
	if len(commentIDs) == 0 || fingerprint == "" {
		return map[int64][]string{}, nil
	}
	placeholders := make([]string, len(commentIDs))
	args := make([]interface{}, len(commentIDs))
	for i, id := range commentIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	args = append(args, fingerprint)
	query := `SELECT comment_id, emoji FROM comment_reactions
		WHERE comment_id IN (` + strings.Join(placeholders, ",") + `) AND fingerprint = ?`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64][]string{}
	for rows.Next() {
		var cid int64
		var emoji string
		if err := rows.Scan(&cid, &emoji); err != nil {
			return nil, err
		}
		result[cid] = append(result[cid], emoji)
	}
	return result, nil
}

// --- Recent & Hot comments ---

func (s *SQLiteStore) GetRecentComments(ctx context.Context, siteID string, limit int) ([]*model.CommentWithAuthor, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id, c.page_slug, c.parent_id, c.content, c.created_at,
		       u.id, u.nickname, u.avatar_seed, u.blog_url, u.bio
		FROM comments c
		LEFT JOIN commenters u ON c.commenter_id = u.id
		WHERE c.site_id = ? AND c.status = 'approved'
		ORDER BY c.created_at DESC LIMIT ?`, siteID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCommentsWithAuthor(rows)
}

func (s *SQLiteStore) GetHotComments(ctx context.Context, siteID string, limit int) ([]*model.CommentWithAuthor, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id, c.page_slug, c.parent_id, c.content, c.created_at,
		       u.id, u.nickname, u.avatar_seed, u.blog_url, u.bio
		FROM comments c
		LEFT JOIN commenters u ON c.commenter_id = u.id
		JOIN (SELECT comment_id, COUNT(*) AS cnt FROM comment_reactions GROUP BY comment_id) r
		  ON r.comment_id = c.id
		WHERE c.site_id = ? AND c.status = 'approved'
		ORDER BY r.cnt DESC, c.created_at DESC LIMIT ?`, siteID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCommentsWithAuthor(rows)
}

func scanCommentsWithAuthor(rows *sql.Rows) ([]*model.CommentWithAuthor, error) {
	var result []*model.CommentWithAuthor
	for rows.Next() {
		var c model.CommentWithAuthor
		var createdAt time.Time
		var authorID sql.NullInt64
		var authorNickname, authorAvatar, authorBlog, authorBio sql.NullString
		if err := rows.Scan(&c.ID, &c.PageSlug, &c.ParentID, &c.Content, &createdAt,
			&authorID, &authorNickname, &authorAvatar, &authorBlog, &authorBio); err != nil {
			return nil, err
		}
		c.CreatedAt = createdAt.Format(time.RFC3339)
		if authorID.Valid {
			c.Author = &model.CommenterPublic{
				ID: authorID.Int64, Nickname: authorNickname.String,
				AvatarSeed: authorNickname.String, BlogURL: authorBlog.String, Bio: authorBio.String,
			}
		} else {
			c.Author = &model.CommenterPublic{ID: 0, Nickname: "作者", AvatarSeed: "admin"}
		}
		result = append(result, &c)
	}
	if result == nil {
		result = []*model.CommentWithAuthor{}
	}
	return result, nil
}

// --- Page reactions ---

func (s *SQLiteStore) AddPageReaction(ctx context.Context, siteID, pageSlug, emoji, fingerprint string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO page_reactions (site_id, page_slug, emoji, fingerprint) VALUES (?, ?, ?, ?)`,
		siteID, pageSlug, emoji, fingerprint)
	return err
}

func (s *SQLiteStore) RemovePageReaction(ctx context.Context, siteID, pageSlug, emoji, fingerprint string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM page_reactions WHERE site_id = ? AND page_slug = ? AND emoji = ? AND fingerprint = ?`,
		siteID, pageSlug, emoji, fingerprint)
	return err
}

func (s *SQLiteStore) GetPageReactions(ctx context.Context, siteID, pageSlug string) ([]model.ReactionCount, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT emoji, COUNT(*) FROM page_reactions WHERE site_id = ? AND page_slug = ? GROUP BY emoji ORDER BY COUNT(*) DESC`,
		siteID, pageSlug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []model.ReactionCount
	for rows.Next() {
		var rc model.ReactionCount
		if err := rows.Scan(&rc.Emoji, &rc.Count); err != nil {
			return nil, err
		}
		result = append(result, rc)
	}
	if result == nil {
		result = []model.ReactionCount{}
	}
	return result, nil
}

func (s *SQLiteStore) GetUserPageReactions(ctx context.Context, siteID, pageSlug, fingerprint string) ([]string, error) {
	if fingerprint == "" {
		return []string{}, nil
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT emoji FROM page_reactions WHERE site_id = ? AND page_slug = ? AND fingerprint = ?`,
		siteID, pageSlug, fingerprint)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var emoji string
		if err := rows.Scan(&emoji); err != nil {
			return nil, err
		}
		result = append(result, emoji)
	}
	if result == nil {
		result = []string{}
	}
	return result, nil
}

// Close closes the database connection.
func (s *SQLiteStore) Close() error {
	return s.db.Close()
}
