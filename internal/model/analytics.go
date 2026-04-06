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
