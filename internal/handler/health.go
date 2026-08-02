package handler

import (
	"fmt"
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

func formatDuration(d time.Duration) string {
	d = d.Truncate(time.Second)
	days := int(d.Hours()) / 24
	d -= time.Duration(days) * 24 * time.Hour
	hours := int(d.Hours())
	d -= time.Duration(hours) * time.Hour
	minutes := int(d.Minutes())
	d -= time.Duration(minutes) * time.Minute
	seconds := int(d.Seconds())

	if days > 0 {
		return fmt.Sprintf("%dd%dh%dm%ds", days, hours, minutes, seconds)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh%dm%ds", hours, minutes, seconds)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm%ds", minutes, seconds)
	}
	return fmt.Sprintf("%ds", seconds)
}

// HandleHealth handles GET /api/v1/health
func (h *HealthHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	data := map[string]interface{}{
		"uptime": formatDuration(time.Since(h.startTime)),
	}
	if h.debug {
		data["version"] = h.version
	}

	writeJSON(w, http.StatusOK, apiResponse{
		OK:   true,
		Data: data,
	})
}
