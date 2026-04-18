package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/thinkycx/blog-helper/internal/config"
	"github.com/thinkycx/blog-helper/internal/handler"
	"github.com/thinkycx/blog-helper/internal/service"
	"github.com/thinkycx/blog-helper/internal/store"
)

// version is set at build time via -ldflags
var version = "dev"

func main() {
	cfg := config.Parse(version)

	log.Printf("Blog Helper Server %s starting...", cfg.Version)
	log.Printf("Listen: %s, DB: %s, Origins: %v", cfg.Addr, cfg.DBPath, cfg.AllowedOrigins)

	// Ensure database directory exists
	dbDir := filepath.Dir(cfg.DBPath)
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		log.Fatalf("Failed to create database directory %s: %v", dbDir, err)
	}

	// Initialize store
	sqliteStore, err := store.NewSQLiteStore(cfg.DBPath)
	if err != nil {
		log.Fatalf("Failed to initialize store: %v", err)
	}
	defer sqliteStore.Close()

	// Initialize service
	svc := service.NewAnalyticsService(sqliteStore)

	// Initialize handlers
	analyticsHandler := handler.NewAnalyticsHandler(svc)
	healthHandler := handler.NewHealthHandler(cfg.Version, cfg.Debug)
	dashboardHandler := handler.NewDashboardHandler(cfg.Version)

	// Setup routes
	mux := http.NewServeMux()

	// Dashboard auth middleware (protects dashboard + raw views)
	dashAuth := handler.DashboardAuthMiddleware(cfg.DashboardPassword)

	// API v1 routes (public — used by SDK)
	mux.HandleFunc("/api/v1/analytics/report", analyticsHandler.HandleReport)
	mux.HandleFunc("/api/v1/analytics/stats", analyticsHandler.HandleStats)
	mux.HandleFunc("/api/v1/analytics/stats/batch", analyticsHandler.HandleBatchStats)
	mux.HandleFunc("/api/v1/analytics/popular", analyticsHandler.HandlePopular)
	mux.HandleFunc("/api/v1/analytics/active", analyticsHandler.HandleActive)
	mux.HandleFunc("/api/v1/analytics/trend", analyticsHandler.HandleTrend)
	mux.HandleFunc("/api/v1/analytics/referrers", analyticsHandler.HandleReferrers)
	mux.HandleFunc("/api/v1/analytics/platforms", analyticsHandler.HandlePlatforms)
	mux.HandleFunc("/api/v1/analytics/summary", analyticsHandler.HandleSummary)
	mux.HandleFunc("/api/v1/health", healthHandler.HandleHealth)

	// Protected routes (require dashboard password)
	mux.Handle("/api/v1/dashboard", dashAuth(http.HandlerFunc(dashboardHandler.HandleDashboard)))
	mux.Handle("/api/v1/analytics/views", dashAuth(http.HandlerFunc(analyticsHandler.HandleViews)))
	mux.Handle("/api/v1/analytics/visitors", dashAuth(http.HandlerFunc(analyticsHandler.HandleVisitors)))
	mux.Handle("/api/v1/analytics/visitor", dashAuth(http.HandlerFunc(analyticsHandler.HandleVisitorSearch)))

	// Apply middleware chain (outermost first)
	var h http.Handler = mux
	h = handler.RealIPMiddleware(h)
	h = handler.CORSMiddleware(cfg.AllowedOrigins)(h)
	h = handler.LoggingMiddleware(h)
	h = handler.RecoveryMiddleware(h)

	// Create server
	srv := &http.Server{
		Addr:         cfg.Addr,
		Handler:      h,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("Server listening on %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for shutdown signal
	<-done
	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server shutdown error: %v", err)
	}

	log.Println("Server stopped gracefully")
}
