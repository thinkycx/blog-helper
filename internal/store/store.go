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

	// --- Comment system ---

	// CreateCommenter inserts a new commenter and returns the created record.
	CreateCommenter(ctx context.Context, c *model.Commenter) (*model.Commenter, error)

	// GetCommenterByEmail returns a commenter by email, or nil if not found.
	GetCommenterByEmail(ctx context.Context, email string) (*model.Commenter, error)

	// UpdateCommenterProfile updates editable fields (nickname, avatar_seed, blog_url, bio).
	UpdateCommenterProfile(ctx context.Context, id int64, nickname, avatarSeed, blogURL, bio string) error

	// CreateCommenterToken inserts a new token record.
	CreateCommenterToken(ctx context.Context, t *model.CommenterToken) error

	// GetCommenterByToken returns the commenter associated with a token, or nil if invalid.
	GetCommenterByToken(ctx context.Context, token string) (*model.Commenter, error)

	// UpdateLastSeen updates the commenter's last_seen_at timestamp.
	UpdateLastSeen(ctx context.Context, commenterID int64) error

	// CreateComment inserts a new comment.
	CreateComment(ctx context.Context, c *model.Comment) (*model.Comment, error)

	// GetCommentsBySlug returns approved comments for a page, joined with author info.
	GetCommentsBySlug(ctx context.Context, siteID, slug string) ([]*model.CommentWithAuthor, error)

	// GetAllComments returns all comments (any status) with pagination, joined with author info and page title.
	GetAllComments(ctx context.Context, siteID string, limit, offset int) ([]*model.CommentWithAuthor, int, error)

	// GetAllCommenters returns all commenters with pagination.
	GetAllCommenters(ctx context.Context, limit, offset int) ([]*model.Commenter, int, error)

	// GetPendingComments returns comments awaiting moderation.
	GetPendingComments(ctx context.Context, siteID string) ([]*model.CommentWithAuthor, error)

	// UpdateCommentStatus sets a comment's status (approved, rejected).
	UpdateCommentStatus(ctx context.Context, id int64, status string) error

	// DeleteComment removes a comment by ID.
	DeleteComment(ctx context.Context, id int64) error

	// GetCommentCounts returns comment counts for multiple slugs.
	GetCommentCounts(ctx context.Context, siteID string, slugs []string) ([]*model.CommentCountItem, error)

	// AddReaction adds an emoji reaction (idempotent per fingerprint).
	AddReaction(ctx context.Context, commentID int64, emoji, fingerprint string) error

	// RemoveReaction removes an emoji reaction.
	RemoveReaction(ctx context.Context, commentID int64, emoji, fingerprint string) error

	// GetReactionsByCommentIDs returns aggregated reaction counts per comment.
	GetReactionsByCommentIDs(ctx context.Context, commentIDs []int64) (map[int64][]model.ReactionCount, error)

	// GetUserReactions returns which emojis the given fingerprint has reacted with.
	GetUserReactions(ctx context.Context, commentIDs []int64, fingerprint string) (map[int64][]string, error)

	// GetRecentComments returns the most recent approved comments across all pages.
	GetRecentComments(ctx context.Context, siteID string, limit int) ([]*model.CommentWithAuthor, error)

	// GetHotComments returns comments with the most reactions.
	GetHotComments(ctx context.Context, siteID string, limit int) ([]*model.CommentWithAuthor, error)

	// --- Page reactions ---

	// AddPageReaction adds an emoji reaction to a page (idempotent per fingerprint).
	AddPageReaction(ctx context.Context, siteID, pageSlug, emoji, fingerprint string) error

	// RemovePageReaction removes an emoji reaction from a page.
	RemovePageReaction(ctx context.Context, siteID, pageSlug, emoji, fingerprint string) error

	// GetPageReactions returns aggregated reaction counts for a page.
	GetPageReactions(ctx context.Context, siteID, pageSlug string) ([]model.ReactionCount, error)

	// GetUserPageReactions returns which emojis the given fingerprint has reacted with on a page.
	GetUserPageReactions(ctx context.Context, siteID, pageSlug, fingerprint string) ([]string, error)

	// GetEngagementStats returns total page reactions and commenter count.
	// days=0 means all time.
	GetEngagementStats(ctx context.Context, siteID string, days int) (likes int64, commenters int64, err error)

	// Close closes the underlying database connection.
	Close() error
}
