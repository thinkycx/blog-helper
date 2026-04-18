package store

import (
	"context"
	"database/sql"
	"fmt"
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
	dsn := fmt.Sprintf("%s?_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)&_pragma=synchronous(normal)&_pragma=foreign_keys(on)", dbPath)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// Set connection pool (SQLite is single-writer, but multiple readers)
	db.SetMaxOpenConns(1) // single writer
	db.SetMaxIdleConns(1)
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

// Close closes the database connection.
func (s *SQLiteStore) Close() error {
	return s.db.Close()
}
