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

	// Close closes the underlying database connection.
	Close() error
}
