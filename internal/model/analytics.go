package model

import "time"

// PageView represents a single page view event.
type PageView struct {
	ID          int64     `json:"id"`
	SiteID      string    `json:"site_id"`      // Hostname, e.g. "example.com"
	PageSlug    string    `json:"page_slug"`
	PageTitle   string    `json:"page_title"`
	Fingerprint string    `json:"fingerprint"`
	IP          string    `json:"ip"`
	UserAgent   string    `json:"user_agent"`
	Referrer    string    `json:"referrer"`
	CreatedAt   time.Time `json:"created_at"`
}

// PageStats represents the aggregated stats for a single page.
type PageStats struct {
	SiteID    string    `json:"site_id,omitempty"`
	PageSlug  string    `json:"page_slug"`
	PageTitle string    `json:"page_title,omitempty"`
	PVCount   int64     `json:"pv"`
	UVCount   int64     `json:"uv"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
}

// DailyStat represents daily aggregated stats for a page.
type DailyStat struct {
	SiteID   string `json:"site_id"`
	PageSlug string `json:"page_slug"`
	Date     string `json:"date"`
	PVCount  int64  `json:"pv"`
	UVCount  int64  `json:"uv"`
}

// PopularArticle represents a popular article entry for sidebar ranking.
type PopularArticle struct {
	PageSlug  string `json:"page_slug"`
	PageTitle string `json:"page_title"`
	PVCount   int64  `json:"pv"`
}

// SiteDailyStat represents one day in the site-wide PV/UV trend.
type SiteDailyStat struct {
	Date    string `json:"date"` // "2024-01-15"
	PVCount int64  `json:"pv"`
	UVCount int64  `json:"uv"`
}

// ReferrerStat represents a referrer domain and its visit count.
type ReferrerStat struct {
	Domain string `json:"domain"` // "google.com", "direct"
	Count  int64  `json:"count"`
}

// PlatformStat represents a user-agent platform category and its count.
type PlatformStat struct {
	Platform string `json:"platform"` // "Windows", "macOS", "Linux", "iOS", "Android", "Other"
	Count    int64  `json:"count"`
}

// ActiveVisitors represents the count of distinct visitors in a recent time window.
type ActiveVisitors struct {
	Count   int64 `json:"count"`
	Minutes int   `json:"minutes"`
}

// VisitorSummary represents a unique visitor with their recent activity.
type VisitorSummary struct {
	Fingerprint   string `json:"fingerprint"`
	LastIP        string `json:"last_ip"`
	LastUA        string `json:"last_ua"`
	LastPage      string `json:"last_page"`
	LastPageTitle string `json:"last_page_title"`
	LastSeen      string `json:"last_seen"`
	PageViews     int64  `json:"page_views"`
}

// PageViewRecord represents a raw page view for the dashboard detail view.
type PageViewRecord struct {
	ID          int64  `json:"id"`
	PageSlug    string `json:"page_slug"`
	PageTitle   string `json:"page_title"`
	Fingerprint string `json:"fingerprint"`
	IP          string `json:"ip"`
	UserAgent   string `json:"user_agent"`
	Referrer    string `json:"referrer"`
	CreatedAt   string `json:"created_at"` // formatted string for JSON
}

// PageViewList wraps a page of raw page view records with pagination info.
type PageViewList struct {
	Records []*PageViewRecord `json:"records"`
	Total   int64             `json:"total"`
	Limit   int               `json:"limit"`
	Offset  int               `json:"offset"`
}
