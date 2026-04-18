package handler

import (
	"crypto/sha256"
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// CORSMiddleware handles Cross-Origin Resource Sharing.
func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	originSet := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		originSet[strings.TrimRight(o, "/")] = true
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			if originSet[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Access-Control-Max-Age", "86400")
			}

			// Handle preflight
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// LoggingMiddleware logs request method, path, status, and duration.
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start))
	})
}

// RecoveryMiddleware recovers from panics and returns 500.
func RecoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				log.Printf("PANIC: %v\n%s", err, debug.Stack())
				http.Error(w, `{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}`,
					http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// RealIPMiddleware extracts the real client IP from X-Real-IP or X-Forwarded-For headers.
func RealIPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ip := r.Header.Get("X-Real-IP"); ip != "" {
			r.RemoteAddr = ip
		} else if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Take the first IP in the chain
			if idx := strings.Index(xff, ","); idx > 0 {
				r.RemoteAddr = strings.TrimSpace(xff[:idx])
			} else {
				r.RemoteAddr = strings.TrimSpace(xff)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// DashboardAuthMiddleware protects routes with a simple cookie-based password check.
// On unauthenticated access, it serves a login form. On POST with correct password,
// it sets a cookie and redirects to the dashboard.
func DashboardAuthMiddleware(password string) func(http.Handler) http.Handler {
	tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(password)))

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check auth cookie
			if cookie, err := r.Cookie("_bh_dash_token"); err == nil && cookie.Value == tokenHash {
				next.ServeHTTP(w, r)
				return
			}

			// Handle login POST
			if r.Method == http.MethodPost {
				r.ParseForm()
				if r.FormValue("password") == password {
					http.SetCookie(w, &http.Cookie{
						Name:     "_bh_dash_token",
						Value:    tokenHash,
						Path:     "/api/v1/",
						MaxAge:   30 * 24 * 3600, // 30 days
						HttpOnly: true,
						SameSite: http.SameSiteLaxMode,
					})
					http.Redirect(w, r, "/api/v1/dashboard", http.StatusSeeOther)
					return
				}
				// Wrong password — show login with error
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(loginPageHTML(true)))
				return
			}

			// Not authenticated — show login page
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(loginPageHTML(false)))
		})
	}
}

func loginPageHTML(showError bool) string {
	errMsg := ""
	if showError {
		errMsg = `<div style="color:#ff4d4f;margin-bottom:12px">Incorrect password</div>`
	}
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>Login - Blog Analytics</title>` +
		`<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;` +
		`display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5}` +
		`@media(prefers-color-scheme:dark){body{background:#141414}.box{background:#1f1f1f;border-color:#303030;color:#e8e8e8}` +
		`input{background:#141414;border-color:#303030;color:#e8e8e8}}` +
		`.box{background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:32px;width:320px;text-align:center}` +
		`h1{font-size:18px;margin-bottom:20px}` +
		`input{width:100%;padding:10px 12px;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;outline:none;margin-bottom:12px}` +
		`input:focus{border-color:#1677ff}` +
		`button{width:100%;padding:10px;background:#1677ff;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer}` +
		`button:hover{opacity:0.85}</style></head><body>` +
		`<div class="box"><h1>Blog Analytics</h1>` + errMsg +
		`<form method="POST"><input type="password" name="password" placeholder="Password" autofocus>` +
		`<button type="submit">Login</button></form></div></body></html>`
}

// statusWriter wraps http.ResponseWriter to capture the status code.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
