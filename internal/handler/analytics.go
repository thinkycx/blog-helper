package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/thinkycx/blog-helper/internal/model"
	"github.com/thinkycx/blog-helper/internal/service"
)

// AnalyticsHandler handles analytics API requests.
type AnalyticsHandler struct {
	svc *service.AnalyticsService
}

// NewAnalyticsHandler creates a new analytics handler.
func NewAnalyticsHandler(svc *service.AnalyticsService) *AnalyticsHandler {
	return &AnalyticsHandler{svc: svc}
}

// --- Request/Response types ---

type reportRequest struct {
	SiteID      string `json:"site_id"`
	PageSlug    string `json:"page_slug"`
	PageTitle   string `json:"page_title"`
	Fingerprint string `json:"fingerprint"`
	Referrer    string `json:"referrer"`
}

type batchStatsRequest struct {
	SiteID string   `json:"site_id"`
	Slugs  []string `json:"slugs"`
}

type apiResponse struct {
	OK    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error *apiError   `json:"error,omitempty"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type pvuvData struct {
	PV int64 `json:"pv"`
	UV int64 `json:"uv"`
}

// --- Handlers ---

// HandleReport handles POST /api/v1/analytics/report
func (h *AnalyticsHandler) HandleReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	var req reportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	if req.PageSlug == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "page_slug is required")
		return
	}

	// Resolve site_id: from request body, or fall back to Origin/Referer header
	siteID := req.SiteID
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	// Extract client IP from RemoteAddr (set by RealIPMiddleware)
	clientIP := r.RemoteAddr

	pv := &model.PageView{
		SiteID:      siteID,
		PageSlug:    req.PageSlug,
		PageTitle:   req.PageTitle,
		Fingerprint: req.Fingerprint,
		IP:          clientIP,
		UserAgent:   r.UserAgent(),
		Referrer:    req.Referrer,
	}

	stats, err := h.svc.ReportPageView(r.Context(), pv)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to record page view")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{
		OK:   true,
		Data: pvuvData{PV: stats.PVCount, UV: stats.UVCount},
	})
}

// HandleStats handles GET /api/v1/analytics/stats?slug=...&site_id=...
func (h *AnalyticsHandler) HandleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	slug := r.URL.Query().Get("slug")
	if slug == "" {
		writeError(w, http.StatusBadRequest, "MISSING_PARAM", "slug query parameter is required")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	stats, err := h.svc.GetPageStats(r.Context(), siteID, slug)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get page stats")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{
		OK: true,
		Data: map[string]interface{}{
			"page_slug": stats.PageSlug,
			"pv":        stats.PVCount,
			"uv":        stats.UVCount,
		},
	})
}

// HandleBatchStats handles POST /api/v1/analytics/stats/batch
func (h *AnalyticsHandler) HandleBatchStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	var req batchStatsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	if len(req.Slugs) == 0 {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "slugs array is required")
		return
	}
	if len(req.Slugs) > 100 {
		writeError(w, http.StatusBadRequest, "TOO_MANY", "Maximum 100 slugs per request")
		return
	}

	siteID := req.SiteID
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	statsMap, err := h.svc.BatchGetPageStats(r.Context(), siteID, req.Slugs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get batch stats")
		return
	}

	// Convert to response format: { slug: { pv, uv } }
	data := make(map[string]pvuvData, len(statsMap))
	for slug, stats := range statsMap {
		data[slug] = pvuvData{PV: stats.PVCount, UV: stats.UVCount}
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: data})
}

// HandlePopular handles GET /api/v1/analytics/popular?limit=10&period=30d&site_id=...
func (h *AnalyticsHandler) HandlePopular(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	limit := 10
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 && v <= 50 {
			limit = v
		}
	}

	period := r.URL.Query().Get("period")
	if period == "" {
		period = "30d"
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	articles, err := h.svc.GetPopularArticles(r.Context(), siteID, limit, period)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get popular articles")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: articles})
}

// HandleActive handles GET /api/v1/analytics/active?minutes=30&site_id=...
func (h *AnalyticsHandler) HandleActive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	minutes := 30
	if m := r.URL.Query().Get("minutes"); m != "" {
		if v, err := strconv.Atoi(m); err == nil && v > 0 {
			minutes = v
		}
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	active, err := h.svc.GetActiveVisitors(r.Context(), siteID, minutes)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get active visitors")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: active})
}

// HandleTrend handles GET /api/v1/analytics/trend?period=7d&slug=...&site_id=...
// period: "1h" (5-min buckets), "6h" (30-min), "1d" (hourly), "7d"/"30d"/etc (daily).
// Also accepts ?days=N for backward compatibility.
// If slug is provided, returns per-page trend; otherwise returns site-wide trend.
func (h *AnalyticsHandler) HandleTrend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	slug := r.URL.Query().Get("slug")
	period := r.URL.Query().Get("period")

	// Backward compat: if period not set, derive from days param
	if period == "" {
		days := 30
		if d := r.URL.Query().Get("days"); d != "" {
			if v, err := strconv.Atoi(d); err == nil && v > 0 {
				days = v
			}
		}
		period = strconv.Itoa(days) + "d"
	}

	var trend []*model.SiteDailyStat
	var err error

	switch period {
	case "1h", "6h", "1d":
		trend, err = h.svc.GetRecentTrend(r.Context(), siteID, slug, period)
	default:
		// Parse days from period like "7d", "30d", "365d"
		days := 30
		if strings.HasSuffix(period, "d") {
			if v, e := strconv.Atoi(period[:len(period)-1]); e == nil && v > 0 {
				days = v
			}
		}
		if slug != "" {
			trend, err = h.svc.GetPageTrend(r.Context(), siteID, slug, days)
		} else {
			trend, err = h.svc.GetSiteTrend(r.Context(), siteID, days)
		}
	}

	if err != nil {
		log.Printf("ERROR trend period=%s site=%s slug=%s: %v", period, siteID, slug, err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get trend")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: trend})
}

// HandleReferrers handles GET /api/v1/analytics/referrers?days=30&limit=10&slug=...&site_id=...
// If slug is provided, returns referrers for that page; otherwise returns site-wide referrers.
func (h *AnalyticsHandler) HandleReferrers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	days := 30
	if d := r.URL.Query().Get("days"); d != "" {
		if v, err := strconv.Atoi(d); err == nil && v > 0 {
			days = v
		}
	}

	limit := 10
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			limit = v
		}
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	slug := r.URL.Query().Get("slug")

	var referrers []*model.ReferrerStat
	var err error
	if slug != "" {
		referrers, err = h.svc.GetPageReferrers(r.Context(), siteID, slug, days, limit)
	} else {
		referrers, err = h.svc.GetTopReferrers(r.Context(), siteID, days, limit)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get referrers")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: referrers})
}

// HandlePlatforms handles GET /api/v1/analytics/platforms?days=30&site_id=...
func (h *AnalyticsHandler) HandlePlatforms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	days := 30
	if d := r.URL.Query().Get("days"); d != "" {
		if v, err := strconv.Atoi(d); err == nil && v > 0 {
			days = v
		}
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	stats, err := h.svc.GetPlatformStats(r.Context(), siteID, days)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get platform stats")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: stats})
}

// HandleSummary handles GET /api/v1/analytics/summary?days=30&slug=...&site_id=...
// Returns total PV and deduplicated UV for the period.
func (h *AnalyticsHandler) HandleSummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	days := 0
	if d := r.URL.Query().Get("days"); d != "" {
		if v, err := strconv.Atoi(d); err == nil && v > 0 {
			days = v
		}
	}

	slug := r.URL.Query().Get("slug")

	pv, uv, err := h.svc.GetPeriodSummary(r.Context(), siteID, slug, days)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get summary")
		return
	}

	likes, commenters, _ := h.svc.GetEngagementStats(r.Context(), siteID, days)

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: map[string]int64{
		"pv": pv, "uv": uv, "likes": likes, "commenters": commenters,
	}})
}

// HandleViews handles GET /api/v1/analytics/views?site_id=...&slug=...&limit=50&offset=0
// Returns raw page view records. Protected by dashboard auth middleware.
func (h *AnalyticsHandler) HandleViews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	slug := r.URL.Query().Get("slug")

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			limit = v
		}
	}

	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if v, err := strconv.Atoi(o); err == nil && v >= 0 {
			offset = v
		}
	}

	days := 0
	if d := r.URL.Query().Get("days"); d != "" {
		if v, err := strconv.Atoi(d); err == nil && v > 0 {
			days = v
		}
	}

	result, err := h.svc.GetRecentPageViews(r.Context(), siteID, slug, days, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get page views")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: result})
}

// HandleVisitors handles GET /api/v1/analytics/visitors?site_id=...&days=30&limit=20&offset=0
// Returns recent unique visitors. Protected by dashboard auth middleware.
func (h *AnalyticsHandler) HandleVisitors(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	days := 0
	if d := r.URL.Query().Get("days"); d != "" {
		if v, err := strconv.Atoi(d); err == nil && v > 0 {
			days = v
		}
	}

	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			limit = v
		}
	}

	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if v, err := strconv.Atoi(o); err == nil && v >= 0 {
			offset = v
		}
	}

	visitors, err := h.svc.GetRecentVisitors(r.Context(), siteID, days, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get visitors")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: visitors})
}

// HandleVisitorSearch handles GET /api/v1/analytics/visitor?site_id=...&fingerprint=xxx&days=30&limit=50&offset=0
// Returns page view history for a specific fingerprint. Protected by dashboard auth middleware.
func (h *AnalyticsHandler) HandleVisitorSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	fingerprint := r.URL.Query().Get("fingerprint")
	if fingerprint == "" {
		writeError(w, http.StatusBadRequest, "MISSING_PARAM", "fingerprint is required")
		return
	}

	days := 0
	if d := r.URL.Query().Get("days"); d != "" {
		if v, err := strconv.Atoi(d); err == nil && v > 0 {
			days = v
		}
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			limit = v
		}
	}

	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if v, err := strconv.Atoi(o); err == nil && v >= 0 {
			offset = v
		}
	}

	result, err := h.svc.SearchVisitor(r.Context(), siteID, fingerprint, days, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to search visitor")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: result})
}

// --- Helpers ---

// extractSiteID derives the site identifier from the request's Origin or Referer header.
// Returns the hostname (e.g. "example.com") or empty string if unable to determine.
func extractSiteID(r *http.Request) string {
	// Try Origin header first (set by browsers on CORS requests)
	if origin := r.Header.Get("Origin"); origin != "" {
		if u, err := url.Parse(origin); err == nil && u.Hostname() != "" {
			return strings.ToLower(u.Hostname())
		}
	}

	// Fall back to Referer header
	if referer := r.Header.Get("Referer"); referer != "" {
		if u, err := url.Parse(referer); err == nil && u.Hostname() != "" {
			return strings.ToLower(u.Hostname())
		}
	}

	// Fall back to Host header (useful when API is same-origin)
	if host := r.Host; host != "" {
		// Strip port
		if idx := strings.LastIndex(host, ":"); idx > 0 {
			return strings.ToLower(host[:idx])
		}
		return strings.ToLower(host)
	}

	return ""
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, apiResponse{
		OK:    false,
		Error: &apiError{Code: code, Message: message},
	})
}
