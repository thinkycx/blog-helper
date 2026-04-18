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

	// Attempt v1→v2 migration: add site_id columns to existing tables.
	// These will fail silently if the column already exists (fresh install) or succeed on upgrade.
	migrateV1ToV2(db)

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

	// 1. Insert raw page view event
	_, err = tx.ExecContext(ctx, `
		INSERT INTO page_views (site_id, page_slug, page_title, fingerprint, ip, user_agent, referrer, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		pv.SiteID, pv.PageSlug, pv.PageTitle, pv.Fingerprint, pv.IP, pv.UserAgent, pv.Referrer, now)
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
			uv_count = (SELECT COUNT(DISTINCT fingerprint) FROM page_views WHERE site_id = ? AND page_slug = ? AND fingerprint != ''),
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
				WHERE site_id = ? AND page_slug = ? AND date(created_at) = ? AND fingerprint != '')`,
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
				WHERE site_id = ? AND date(created_at) = ? AND fingerprint != '')`,
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
		SELECT fingerprint, ip, user_agent, page_slug, created_at, cnt
		FROM (
			SELECT fingerprint, ip, user_agent, page_slug, created_at,
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
		if err := rows.Scan(&v.Fingerprint, &v.LastIP, &v.LastUA, &v.LastPage, &v.LastSeen, &v.PageViews); err != nil {
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

// Close closes the database connection.
func (s *SQLiteStore) Close() error {
	return s.db.Close()
}
