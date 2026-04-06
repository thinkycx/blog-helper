package handler

import (
	"encoding/json"
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
