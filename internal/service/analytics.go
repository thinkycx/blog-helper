package service

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/thinkycx/blog-helper/internal/model"
	"github.com/thinkycx/blog-helper/internal/store"
)

// AnalyticsService implements the business logic for page view analytics.
type AnalyticsService struct {
	store store.Store

	// In-memory rate limiter: siteID+fingerprint+slug → last report time
	// Prevents the same visitor from inflating PV within a short window.
	rateMu    sync.Mutex
	rateCache map[string]time.Time
}

// NewAnalyticsService creates a new analytics service.
func NewAnalyticsService(s store.Store) *AnalyticsService {
	svc := &AnalyticsService{
		store:     s,
		rateCache: make(map[string]time.Time),
	}

	// Start background cleanup goroutine
	go svc.cleanupRateCache()

	return svc
}

// ReportPageView records a page view event.
// It applies dedup: same siteID + fingerprint + slug within 30s is ignored (returns cached stats).
func (s *AnalyticsService) ReportPageView(ctx context.Context, pv *model.PageView) (*model.PageStats, error) {
	// Normalize
	pv.PageSlug = normalizeSlug(pv.PageSlug)
	pv.SiteID = normalizeSiteID(pv.SiteID)

	// Skip bots
	if isBot(pv.UserAgent) {
		return s.store.GetPageStats(ctx, pv.SiteID, pv.PageSlug)
	}

	// Rate limit check: same siteID + fingerprint + slug within 30s
	if pv.Fingerprint != "" {
		key := pv.SiteID + "|" + pv.Fingerprint + "|" + pv.PageSlug
		s.rateMu.Lock()
		if lastTime, ok := s.rateCache[key]; ok && time.Since(lastTime) < 30*time.Second {
			s.rateMu.Unlock()
			// Return current stats without recording
			return s.store.GetPageStats(ctx, pv.SiteID, pv.PageSlug)
		}
		s.rateCache[key] = time.Now()
		s.rateMu.Unlock()
	}

	return s.store.RecordPageView(ctx, pv)
}

// GetPageStats returns stats for a single page within a site.
func (s *AnalyticsService) GetPageStats(ctx context.Context, siteID, slug string) (*model.PageStats, error) {
	return s.store.GetPageStats(ctx, normalizeSiteID(siteID), normalizeSlug(slug))
}

// BatchGetPageStats returns stats for multiple pages within a site.
func (s *AnalyticsService) BatchGetPageStats(ctx context.Context, siteID string, slugs []string) (map[string]*model.PageStats, error) {
	normalized := make([]string, len(slugs))
	for i, slug := range slugs {
		normalized[i] = normalizeSlug(slug)
	}
	return s.store.BatchGetPageStats(ctx, normalizeSiteID(siteID), normalized)
}

// GetPopularArticles returns top articles by PV within a site.
func (s *AnalyticsService) GetPopularArticles(ctx context.Context, siteID string, limit int, period string) ([]*model.PopularArticle, error) {
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	switch period {
	case "7d", "30d", "all":
		// valid
	default:
		period = "30d"
	}
	return s.store.GetPopularArticles(ctx, normalizeSiteID(siteID), limit, period)
}

// GetActiveVisitors returns the count of distinct visitors in the last N minutes.
func (s *AnalyticsService) GetActiveVisitors(ctx context.Context, siteID string, minutes int) (*model.ActiveVisitors, error) {
	if minutes <= 0 || minutes > 1440 {
		minutes = 30
	}
	return s.store.GetActiveVisitors(ctx, normalizeSiteID(siteID), minutes)
}

// GetSiteTrend returns site-wide daily PV/UV for the last N days.
func (s *AnalyticsService) GetSiteTrend(ctx context.Context, siteID string, days int) ([]*model.SiteDailyStat, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	return s.store.GetSiteTrend(ctx, normalizeSiteID(siteID), days)
}

// GetPlatformStats returns UA platform distribution for the last N days.
func (s *AnalyticsService) GetPlatformStats(ctx context.Context, siteID string, days int) ([]*model.PlatformStat, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	return s.store.GetPlatformStats(ctx, normalizeSiteID(siteID), days)
}

// GetRecentTrend returns PV/UV trend for sub-daily periods (1h, 6h, 1d).
func (s *AnalyticsService) GetRecentTrend(ctx context.Context, siteID, slug, period string) ([]*model.SiteDailyStat, error) {
	normalizedSlug := ""
	if slug != "" {
		normalizedSlug = normalizeSlug(slug)
	}
	return s.store.GetRecentTrend(ctx, normalizeSiteID(siteID), normalizedSlug, period)
}

// GetPageTrend returns per-page daily PV/UV for the last N days.
func (s *AnalyticsService) GetPageTrend(ctx context.Context, siteID, slug string, days int) ([]*model.SiteDailyStat, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	return s.store.GetPageTrend(ctx, normalizeSiteID(siteID), normalizeSlug(slug), days)
}

// GetPageReferrers returns top referrer domains for a specific page.
func (s *AnalyticsService) GetPageReferrers(ctx context.Context, siteID, slug string, days, limit int) ([]*model.ReferrerStat, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	return s.store.GetPageReferrers(ctx, normalizeSiteID(siteID), normalizeSlug(slug), days, limit)
}

// GetRecentPageViews returns raw page view records with pagination.
func (s *AnalyticsService) GetRecentPageViews(ctx context.Context, siteID, slug string, days, limit, offset int) (*model.PageViewList, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	if days < 0 {
		days = 0
	}
	normalizedSlug := ""
	if slug != "" {
		normalizedSlug = normalizeSlug(slug)
	}
	return s.store.GetRecentPageViews(ctx, normalizeSiteID(siteID), normalizedSlug, days, limit, offset)
}

// GetRecentVisitors returns unique visitors ordered by last seen time.
func (s *AnalyticsService) GetRecentVisitors(ctx context.Context, siteID string, days, limit, offset int) ([]*model.VisitorSummary, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}
	if days < 0 {
		days = 0
	}
	return s.store.GetRecentVisitors(ctx, normalizeSiteID(siteID), days, limit, offset)
}

// SearchVisitor returns page view history for a specific fingerprint.
func (s *AnalyticsService) SearchVisitor(ctx context.Context, siteID, fingerprint string, days, limit, offset int) (*model.PageViewList, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	if days < 0 {
		days = 0
	}
	return s.store.SearchVisitor(ctx, normalizeSiteID(siteID), fingerprint, days, limit, offset)
}

// GetPeriodSummary returns total PV and deduplicated UV for a period.
func (s *AnalyticsService) GetPeriodSummary(ctx context.Context, siteID, slug string, days int) (int64, int64, error) {
	normalizedSlug := ""
	if slug != "" {
		normalizedSlug = normalizeSlug(slug)
	}
	if days < 0 {
		days = 0
	}
	return s.store.GetPeriodSummary(ctx, normalizeSiteID(siteID), normalizedSlug, days)
}

func (s *AnalyticsService) GetEngagementStats(ctx context.Context, siteID string, days int) (int64, int64, error) {
	if days < 0 {
		days = 0
	}
	return s.store.GetEngagementStats(ctx, normalizeSiteID(siteID), days)
}

// GetTopReferrers returns the top N referrer domains within the last N days.
func (s *AnalyticsService) GetTopReferrers(ctx context.Context, siteID string, days int, limit int) ([]*model.ReferrerStat, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	return s.store.GetTopReferrers(ctx, normalizeSiteID(siteID), days, limit)
}

// normalizeSlug cleans up a page slug for consistent storage.
func normalizeSlug(slug string) string {
	slug = strings.TrimSpace(slug)
	// Strip trailing slashes (but keep root "/")
	for len(slug) > 1 && strings.HasSuffix(slug, "/") {
		slug = slug[:len(slug)-1]
	}
	// Ensure leading slash
	if slug == "" || slug[0] != '/' {
		slug = "/" + slug
	}
	return slug
}

// normalizeSiteID cleans up a site ID (hostname) for consistent storage.
func normalizeSiteID(siteID string) string {
	siteID = strings.TrimSpace(siteID)
	siteID = strings.ToLower(siteID)
	// Strip port if present (e.g. "localhost:4000" → "localhost")
	// But keep it for non-standard ports in dev
	return siteID
}

// isBot checks if the User-Agent belongs to a known crawler/bot.
func isBot(ua string) bool {
	ua = strings.ToLower(ua)
	bots := []string{
		"googlebot", "bingbot", "slurp", "duckduckbot", "baidu",
		"yandex", "sogou", "exabot", "facebot", "ia_archiver",
		"crawl", "spider", "bot/", "headlesschrome",
	}
	for _, bot := range bots {
		if strings.Contains(ua, bot) {
			return true
		}
	}
	return false
}

// cleanupRateCache periodically removes expired entries from the rate cache.
func (s *AnalyticsService) cleanupRateCache() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		s.rateMu.Lock()
		now := time.Now()
		for key, t := range s.rateCache {
			if now.Sub(t) > time.Minute {
				delete(s.rateCache, key)
			}
		}
		s.rateMu.Unlock()
	}
}
