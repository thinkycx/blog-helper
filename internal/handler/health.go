package handler

import (
	"net/http"
	"time"
)

// HealthHandler handles health check requests.
type HealthHandler struct {
	version   string
	debug     bool
	startTime time.Time
}

// NewHealthHandler creates a new health handler.
func NewHealthHandler(version string, debug bool) *HealthHandler {
	return &HealthHandler{
		version:   version,
		debug:     debug,
		startTime: time.Now(),
	}
}

// HandleHealth handles GET /api/v1/health
func (h *HealthHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	data := map[string]interface{}{
		"uptime": time.Since(h.startTime).Truncate(time.Second).String(),
	}
	if h.debug {
		data["version"] = h.version
	}

	writeJSON(w, http.StatusOK, apiResponse{
		OK:   true,
		Data: data,
	})
}
