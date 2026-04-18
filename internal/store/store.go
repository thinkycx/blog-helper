package store

import (
	"context"

	"github.com/thinkycx/blog-helper/internal/model"
)

// Store defines the repository interface for analytics data.
// Implementations can be swapped (SQLite, PostgreSQL, etc.) without changing business logic.
// All methods require a siteID parameter to isolate data between different sites
// hosted on the same blog-helper instance (e.g. "site-a.com", "site-b.com").
type Store interface {
	// RecordPageView inserts a raw page view event and updates all aggregate tables.
	// Returns the updated PageStats for the given slug within the specified site.
	RecordPageView(ctx context.Context, pv *model.PageView) (*model.PageStats, error)

	// GetPageStats returns the aggregated stats for a single page slug within a site.
	GetPageStats(ctx context.Context, siteID, slug string) (*model.PageStats, error)

	// BatchGetPageStats returns stats for multiple page slugs at once within a site.
	BatchGetPageStats(ctx context.Context, siteID string, slugs []string) (map[string]*model.PageStats, error)

	// GetPopularArticles returns the top N articles ranked by PV within a time period for a site.
	// period: "7d", "30d", "all"
	GetPopularArticles(ctx context.Context, siteID string, limit int, period string) ([]*model.PopularArticle, error)

	// GetSiteTrend returns site-wide daily PV/UV for the last N days.
	GetSiteTrend(ctx context.Context, siteID string, days int) ([]*model.SiteDailyStat, error)

	// GetTopReferrers returns the top N referrer domains within the last N days.
	GetTopReferrers(ctx context.Context, siteID string, days int, limit int) ([]*model.ReferrerStat, error)

	// GetActiveVisitors returns the count of distinct fingerprints in the last N minutes.
	GetActiveVisitors(ctx context.Context, siteID string, minutes int) (*model.ActiveVisitors, error)

	// GetPageTrend returns per-page daily PV/UV for the last N days.
	GetPageTrend(ctx context.Context, siteID, slug string, days int) ([]*model.SiteDailyStat, error)

	// GetRecentTrend returns PV/UV trend for sub-daily periods (1h, 6h, 1d)
	// by querying raw page_views with appropriate time bucket aggregation.
	GetRecentTrend(ctx context.Context, siteID, slug, period string) ([]*model.SiteDailyStat, error)

	// GetPlatformStats returns UA platform distribution for the last N days.
	GetPlatformStats(ctx context.Context, siteID string, days int) ([]*model.PlatformStat, error)

	// GetPageReferrers returns top referrer domains for a specific page.
	GetPageReferrers(ctx context.Context, siteID, slug string, days, limit int) ([]*model.ReferrerStat, error)

	// GetRecentPageViews returns raw page view records with pagination.
	// days=0 means no time filter (all time).
	GetRecentPageViews(ctx context.Context, siteID, slug string, days, limit, offset int) (*model.PageViewList, error)

	// GetRecentVisitors returns unique visitors ordered by last seen time.
	// days=0 means no time filter (all time).
	GetRecentVisitors(ctx context.Context, siteID string, days, limit, offset int) ([]*model.VisitorSummary, error)

	// SearchVisitor returns page view history for a specific fingerprint.
	// days=0 means no time filter (all time).
	SearchVisitor(ctx context.Context, siteID, fingerprint string, days, limit, offset int) (*model.PageViewList, error)

	// GetPeriodSummary returns total PV and deduplicated UV for a given period.
	// slug="" means site-wide; days=0 means all time.
	GetPeriodSummary(ctx context.Context, siteID, slug string, days int) (pv int64, uv int64, err error)

	// Close closes the underlying database connection.
	Close() error
}
