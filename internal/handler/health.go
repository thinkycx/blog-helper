package handler

import (
	"net/http"
	"time"
)

// HealthHandler handles health check requests.
type HealthHandler struct {
	version   string
	startTime time.Time
}

// NewHealthHandler creates a new health handler.
func NewHealthHandler(version string) *HealthHandler {
	return &HealthHandler{
		version:   version,
		startTime: time.Now(),
	}
}

// HandleHealth handles GET /api/v1/health
func (h *HealthHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{
		OK: true,
		Data: map[string]interface{}{
			"version": h.version,
			"uptime":  time.Since(h.startTime).String(),
		},
	})
}
