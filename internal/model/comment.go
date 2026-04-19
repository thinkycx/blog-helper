package model

import "time"

// Commenter represents a registered comment author.
type Commenter struct {
	ID         int64      `json:"id"`
	Email      string     `json:"email,omitempty"` // only visible to admin
	Nickname   string     `json:"nickname"`
	AvatarSeed string     `json:"avatar_seed"`
	BlogURL    string     `json:"blog_url"`
	Bio        string     `json:"bio"`
	RegIP      string     `json:"reg_ip,omitempty"`
	RegUA      string     `json:"reg_ua,omitempty"`
	RegFP      string     `json:"reg_fp,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
}

// CommenterPublic is the public-facing subset of Commenter (no IP/UA/FP).
// Email is only populated for "me" (self-view via token).
type CommenterPublic struct {
	ID         int64  `json:"id"`
	Email      string `json:"email,omitempty"`
	Nickname   string `json:"nickname"`
	AvatarSeed string `json:"avatar_seed"`
	BlogURL    string `json:"blog_url"`
	Bio        string `json:"bio"`
}

// CommenterToken ties a browser cookie to a commenter identity.
type CommenterToken struct {
	Token       string    `json:"token"`
	CommenterID int64     `json:"commenter_id"`
	SiteID      string    `json:"site_id"`
	DeviceInfo  string    `json:"device_info"`
	CreatedAt   time.Time `json:"created_at"`
}

// Comment represents a single comment on a page.
type Comment struct {
	ID          int64     `json:"id"`
	SiteID      string    `json:"site_id"`
	PageSlug    string    `json:"page_slug"`
	CommenterID int64     `json:"commenter_id"`
	ParentID    *int64    `json:"parent_id,omitempty"`
	Content     string    `json:"content"`
	Status      string    `json:"status"` // "pending", "approved", "rejected"
	IP          string    `json:"ip,omitempty"`
	UserAgent   string    `json:"user_agent,omitempty"`
	Fingerprint string    `json:"fingerprint,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

// CommentWithAuthor is a comment joined with public author info for API responses.
type CommentWithAuthor struct {
	ID          int64            `json:"id"`
	SiteID      string           `json:"site_id,omitempty"`
	PageSlug    string           `json:"page_slug"`
	PageTitle   string           `json:"page_title,omitempty"`
	ParentID    *int64           `json:"parent_id,omitempty"`
	Content     string           `json:"content"`
	Status      string           `json:"status,omitempty"`
	CreatedAt   string           `json:"created_at"`
	Author      *CommenterPublic `json:"author"`
	Reactions   []ReactionCount  `json:"reactions,omitempty"`
	MyReactions []string         `json:"my_reactions,omitempty"`
	IP          string           `json:"ip,omitempty"`
	UserAgent   string           `json:"user_agent,omitempty"`
	Fingerprint string           `json:"fingerprint,omitempty"`
}

// ReactionCount is an emoji with its count.
type ReactionCount struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
}

// CommentListResponse is the API response for listing comments on a page.
type CommentListResponse struct {
	Comments []*CommentWithAuthor `json:"comments"`
	Total    int                  `json:"total"`
	Me       *CommenterPublic     `json:"me,omitempty"` // current user if token valid
}

// CommentCountItem pairs a slug with its comment count.
type CommentCountItem struct {
	PageSlug string `json:"page_slug"`
	Count    int    `json:"count"`
}

// PageReactionResponse is the API response for page-level reactions.
type PageReactionResponse struct {
	Reactions   []ReactionCount `json:"reactions"`
	MyReactions []string        `json:"my_reactions,omitempty"`
}
