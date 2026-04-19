package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/thinkycx/blog-helper/internal/model"
	"github.com/thinkycx/blog-helper/internal/store"
)

// CommentService implements the business logic for the comment system.
type CommentService struct {
	store       store.Store
	commentMode string // "off", "auto-approve", "moderation"

	// Rate limit: IP → timestamps of recent comment submissions
	rateMu    sync.Mutex
	rateCache map[string][]time.Time
}

// NewCommentService creates a new comment service.
func NewCommentService(s store.Store, commentMode string) *CommentService {
	svc := &CommentService{
		store:       s,
		commentMode: commentMode,
		rateCache:   make(map[string][]time.Time),
	}
	go svc.cleanupRateCache()
	return svc
}

// CommentMode returns the current comment mode.
func (s *CommentService) CommentMode() string {
	return s.commentMode
}

// PostCommentRequest is the input for posting a comment.
type PostCommentRequest struct {
	SiteID      string
	PageSlug    string
	Token       string // cookie token, may be empty
	Email       string // required if no token
	Nickname    string // required for new users
	AvatarSeed  string
	BlogURL     string
	Bio         string
	Content     string
	ParentID    *int64
	IP          string
	UserAgent   string
	Fingerprint string
}

// PostCommentResponse is the output after posting a comment.
type PostCommentResponse struct {
	Comment *model.CommentWithAuthor `json:"comment"`
	Token   string                  `json:"token,omitempty"` // new token if issued
	Me      *model.CommenterPublic  `json:"me"`
}

// PostComment handles the full comment submission flow.
func (s *CommentService) PostComment(ctx context.Context, req *PostCommentRequest) (*PostCommentResponse, error) {
	req.PageSlug = normalizeSlug(req.PageSlug)
	req.SiteID = normalizeSiteID(req.SiteID)

	// Rate limit: max 5 comments per IP per minute
	if req.IP != "" {
		if err := s.checkRateLimit(req.IP); err != nil {
			return nil, err
		}
	}

	var commenter *model.Commenter
	var newToken string

	// Identify commenter
	if req.Token != "" {
		c, err := s.store.GetCommenterByToken(ctx, req.Token)
		if err != nil {
			return nil, fmt.Errorf("lookup token: %w", err)
		}
		if c != nil {
			commenter = c
		}
	}

	if commenter == nil {
		// Need email
		email := strings.TrimSpace(strings.ToLower(req.Email))
		if email == "" {
			return nil, fmt.Errorf("email is required")
		}

		// Look up existing commenter
		existing, err := s.store.GetCommenterByEmail(ctx, email)
		if err != nil {
			return nil, fmt.Errorf("lookup email: %w", err)
		}

		if existing != nil {
			commenter = existing
		} else {
			// Create new commenter
			nickname := strings.TrimSpace(req.Nickname)
			if nickname == "" {
				return nil, fmt.Errorf("nickname is required for new users")
			}
			avatarSeed := req.AvatarSeed
			if avatarSeed == "" {
				avatarSeed = nickname
			}
			c, err := s.store.CreateCommenter(ctx, &model.Commenter{
				Email:      email,
				Nickname:   nickname,
				AvatarSeed: avatarSeed,
				BlogURL:    strings.TrimSpace(req.BlogURL),
				Bio:        strings.TrimSpace(req.Bio),
				RegIP:      req.IP,
				RegUA:      req.UserAgent,
				RegFP:      req.Fingerprint,
			})
			if err != nil {
				return nil, fmt.Errorf("create commenter: %w", err)
			}
			commenter = c
		}

		// Issue new token
		newToken, err = generateToken()
		if err != nil {
			return nil, fmt.Errorf("generate token: %w", err)
		}
		if err := s.store.CreateCommenterToken(ctx, &model.CommenterToken{
			Token:       newToken,
			CommenterID: commenter.ID,
			SiteID:      req.SiteID,
			DeviceInfo:  req.UserAgent,
		}); err != nil {
			return nil, fmt.Errorf("save token: %w", err)
		}
	}

	// Update last seen
	_ = s.store.UpdateLastSeen(ctx, commenter.ID)

	// Determine comment status
	status := "pending"
	if s.commentMode == "auto-approve" {
		status = "approved"
	}

	// Create comment
	comment, err := s.store.CreateComment(ctx, &model.Comment{
		SiteID:      req.SiteID,
		PageSlug:    req.PageSlug,
		CommenterID: commenter.ID,
		ParentID:    req.ParentID,
		Content:     strings.TrimSpace(req.Content),
		Status:      status,
		IP:          req.IP,
		UserAgent:   req.UserAgent,
		Fingerprint: req.Fingerprint,
	})
	if err != nil {
		return nil, fmt.Errorf("create comment: %w", err)
	}

	author := &model.CommenterPublic{
		ID:         commenter.ID,
		Nickname:   commenter.Nickname,
		AvatarSeed: commenter.Nickname,
		BlogURL:    commenter.BlogURL,
		Bio:        commenter.Bio,
	}

	// me includes email (self-view only)
	me := &model.CommenterPublic{
		ID:         commenter.ID,
		Email:      commenter.Email,
		Nickname:   commenter.Nickname,
		AvatarSeed: commenter.Nickname,
		BlogURL:    commenter.BlogURL,
		Bio:        commenter.Bio,
	}

	return &PostCommentResponse{
		Comment: &model.CommentWithAuthor{
			ID:        comment.ID,
			PageSlug:  comment.PageSlug,
			ParentID:  comment.ParentID,
			Content:   comment.Content,
			Status:    comment.Status,
			CreatedAt: comment.CreatedAt.Format("2006-01-02 15:04:05"),
			Author:    author,
		},
		Token: newToken,
		Me:    me,
	}, nil
}

// GetComments returns the comment list for a page, plus current user if token is valid.
// Includes reaction counts and current user's reactions (by fingerprint).
func (s *CommentService) GetComments(ctx context.Context, siteID, slug, token, fingerprint string) (*model.CommentListResponse, error) {
	slug = normalizeSlug(slug)
	siteID = normalizeSiteID(siteID)

	comments, err := s.store.GetCommentsBySlug(ctx, siteID, slug)
	if err != nil {
		return nil, err
	}

	// Override avatar_seed with nickname for display
	for _, c := range comments {
		if c.Author != nil && c.Author.Nickname != "" {
			c.Author.AvatarSeed = c.Author.Nickname
		}
	}

	// Attach reactions
	if len(comments) > 0 {
		commentIDs := make([]int64, len(comments))
		for i, c := range comments {
			commentIDs[i] = c.ID
		}

		reactions, err := s.store.GetReactionsByCommentIDs(ctx, commentIDs)
		if err == nil {
			for _, c := range comments {
				if r, ok := reactions[c.ID]; ok {
					c.Reactions = r
				}
			}
		}

		if fingerprint != "" {
			userReactions, err := s.store.GetUserReactions(ctx, commentIDs, fingerprint)
			if err == nil {
				for _, c := range comments {
					if r, ok := userReactions[c.ID]; ok {
						c.MyReactions = r
					}
				}
			}
		}
	}

	resp := &model.CommentListResponse{
		Comments: comments,
		Total:    len(comments),
	}

	// If token provided, attach current user profile
	if token != "" {
		commenter, err := s.store.GetCommenterByToken(ctx, token)
		if err == nil && commenter != nil {
			_ = s.store.UpdateLastSeen(ctx, commenter.ID)
			resp.Me = &model.CommenterPublic{
				ID:         commenter.ID,
				Email:      commenter.Email, // only for self-view
				Nickname:   commenter.Nickname,
				AvatarSeed: commenter.Nickname,
				BlogURL:    commenter.BlogURL,
				Bio:        commenter.Bio,
			}
		}
	}

	return resp, nil
}

// LookupCommenter returns public commenter info by email, or nil if not found.
func (s *CommentService) LookupCommenter(ctx context.Context, email string) (*model.CommenterPublic, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return nil, fmt.Errorf("email is required")
	}
	c, err := s.store.GetCommenterByEmail(ctx, email)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, nil
	}
	return &model.CommenterPublic{
		ID:         c.ID,
		Nickname:   c.Nickname,
		AvatarSeed: c.AvatarSeed,
		BlogURL:    c.BlogURL,
		Bio:        c.Bio,
	}, nil
}

// UpdateProfile updates a commenter's profile via their token.
func (s *CommentService) UpdateProfile(ctx context.Context, token, nickname, avatarSeed, blogURL, bio string) (*model.CommenterPublic, error) {
	commenter, err := s.store.GetCommenterByToken(ctx, token)
	if err != nil {
		return nil, err
	}
	if commenter == nil {
		return nil, fmt.Errorf("invalid token")
	}

	nickname = strings.TrimSpace(nickname)
	if nickname == "" {
		nickname = commenter.Nickname
	}
	if avatarSeed == "" {
		avatarSeed = commenter.AvatarSeed
	}

	if err := s.store.UpdateCommenterProfile(ctx, commenter.ID, nickname, avatarSeed, strings.TrimSpace(blogURL), strings.TrimSpace(bio)); err != nil {
		return nil, err
	}

	return &model.CommenterPublic{
		ID:         commenter.ID,
		Email:      commenter.Email,
		Nickname:   nickname,
		AvatarSeed: avatarSeed,
		BlogURL:    strings.TrimSpace(blogURL),
		Bio:        strings.TrimSpace(bio),
	}, nil
}

// GetPendingComments returns comments awaiting moderation (admin only).
func (s *CommentService) GetPendingComments(ctx context.Context, siteID string) ([]*model.CommentWithAuthor, error) {
	return s.store.GetPendingComments(ctx, normalizeSiteID(siteID))
}

// ApproveComment approves a pending comment.
func (s *CommentService) ApproveComment(ctx context.Context, id int64) error {
	return s.store.UpdateCommentStatus(ctx, id, "approved")
}

// RejectComment rejects a pending comment.
func (s *CommentService) RejectComment(ctx context.Context, id int64) error {
	return s.store.UpdateCommentStatus(ctx, id, "rejected")
}

// DeleteComment deletes a comment.
func (s *CommentService) DeleteComment(ctx context.Context, id int64) error {
	return s.store.DeleteComment(ctx, id)
}

// GetAllComments returns all comments (any status) with pagination.
func (s *CommentService) GetAllComments(ctx context.Context, siteID string, limit, offset int) ([]*model.CommentWithAuthor, int, error) {
	return s.store.GetAllComments(ctx, normalizeSiteID(siteID), limit, offset)
}

// GetAllCommenters returns all commenters with pagination.
func (s *CommentService) GetAllCommenters(ctx context.Context, limit, offset int) ([]*model.Commenter, int, error) {
	return s.store.GetAllCommenters(ctx, limit, offset)
}

// AdminReply creates a comment as the admin ("作者"), bypassing PoW and rate limits.
func (s *CommentService) AdminReply(ctx context.Context, siteID, pageSlug, content string, parentID *int64) (*model.CommentWithAuthor, error) {
	pageSlug = normalizeSlug(pageSlug)
	siteID = normalizeSiteID(siteID)
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, fmt.Errorf("content is required")
	}

	comment, err := s.store.CreateComment(ctx, &model.Comment{
		SiteID:      siteID,
		PageSlug:    pageSlug,
		CommenterID: 0, // admin marker
		ParentID:    parentID,
		Content:     content,
		Status:      "approved",
	})
	if err != nil {
		return nil, fmt.Errorf("create admin reply: %w", err)
	}

	return &model.CommentWithAuthor{
		ID:        comment.ID,
		SiteID:    comment.SiteID,
		PageSlug:  comment.PageSlug,
		ParentID:  comment.ParentID,
		Content:   comment.Content,
		Status:    comment.Status,
		CreatedAt: comment.CreatedAt.Format("2006-01-02 15:04:05"),
		Author:    &model.CommenterPublic{ID: 0, Nickname: "作者", AvatarSeed: "admin"},
	}, nil
}

// SetCommentMode changes the comment mode at runtime (not persisted).
func (s *CommentService) SetCommentMode(mode string) error {
	switch mode {
	case "off", "auto-approve", "moderation":
		s.commentMode = mode
		return nil
	default:
		return fmt.Errorf("invalid comment mode: %s", mode)
	}
}

// GetCommentCounts returns comment counts for multiple slugs.
func (s *CommentService) GetCommentCounts(ctx context.Context, siteID string, slugs []string) ([]*model.CommentCountItem, error) {
	return s.store.GetCommentCounts(ctx, normalizeSiteID(siteID), slugs)
}

// ReactToComment adds or removes an emoji reaction on a comment.
func (s *CommentService) ReactToComment(ctx context.Context, commentID int64, emoji, fingerprint, action string) error {
	if fingerprint == "" {
		return fmt.Errorf("fingerprint is required")
	}
	switch action {
	case "add":
		return s.store.AddReaction(ctx, commentID, emoji, fingerprint)
	case "remove":
		return s.store.RemoveReaction(ctx, commentID, emoji, fingerprint)
	default:
		return fmt.Errorf("invalid action: %s (must be add or remove)", action)
	}
}

// GetRecentComments returns the most recent approved comments.
func (s *CommentService) GetRecentComments(ctx context.Context, siteID string, limit int) ([]*model.CommentWithAuthor, error) {
	comments, err := s.store.GetRecentComments(ctx, normalizeSiteID(siteID), limit)
	if err != nil {
		return nil, err
	}
	for _, c := range comments {
		if c.Author != nil && c.Author.Nickname != "" {
			c.Author.AvatarSeed = c.Author.Nickname
		}
	}
	return comments, nil
}

// GetHotComments returns comments with the most reactions.
func (s *CommentService) GetHotComments(ctx context.Context, siteID string, limit int) ([]*model.CommentWithAuthor, error) {
	comments, err := s.store.GetHotComments(ctx, normalizeSiteID(siteID), limit)
	if err != nil {
		return nil, err
	}
	for _, c := range comments {
		if c.Author != nil && c.Author.Nickname != "" {
			c.Author.AvatarSeed = c.Author.Nickname
		}
	}
	// Attach reactions
	if len(comments) > 0 {
		commentIDs := make([]int64, len(comments))
		for i, c := range comments {
			commentIDs[i] = c.ID
		}
		reactions, err := s.store.GetReactionsByCommentIDs(ctx, commentIDs)
		if err == nil {
			for _, c := range comments {
				if r, ok := reactions[c.ID]; ok {
					c.Reactions = r
				}
			}
		}
	}
	return comments, nil
}

// ReactToPage adds or removes an emoji reaction on a page.
func (s *CommentService) ReactToPage(ctx context.Context, siteID, pageSlug, emoji, fingerprint, action string) error {
	siteID = normalizeSiteID(siteID)
	pageSlug = normalizeSlug(pageSlug)
	if fingerprint == "" {
		return fmt.Errorf("fingerprint is required")
	}
	switch action {
	case "add":
		return s.store.AddPageReaction(ctx, siteID, pageSlug, emoji, fingerprint)
	case "remove":
		return s.store.RemovePageReaction(ctx, siteID, pageSlug, emoji, fingerprint)
	default:
		return fmt.Errorf("invalid action: %s (must be add or remove)", action)
	}
}

// GetPageReactions returns page-level reaction counts and the current user's reactions.
func (s *CommentService) GetPageReactions(ctx context.Context, siteID, pageSlug, fingerprint string) (*model.PageReactionResponse, error) {
	siteID = normalizeSiteID(siteID)
	pageSlug = normalizeSlug(pageSlug)
	reactions, err := s.store.GetPageReactions(ctx, siteID, pageSlug)
	if err != nil {
		return nil, err
	}
	myReactions, err := s.store.GetUserPageReactions(ctx, siteID, pageSlug, fingerprint)
	if err != nil {
		return nil, err
	}
	return &model.PageReactionResponse{
		Reactions:   reactions,
		MyReactions: myReactions,
	}, nil
}

// --- Rate limiting ---

func (s *CommentService) checkRateLimit(ip string) error {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()

	now := time.Now()
	cutoff := now.Add(-1 * time.Minute)

	timestamps := s.rateCache[ip]
	// Remove expired entries
	valid := timestamps[:0]
	for _, t := range timestamps {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	if len(valid) >= 5 {
		s.rateCache[ip] = valid
		return fmt.Errorf("rate limit exceeded: max 5 comments per minute")
	}

	s.rateCache[ip] = append(valid, now)
	return nil
}

func (s *CommentService) cleanupRateCache() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		s.rateMu.Lock()
		cutoff := time.Now().Add(-2 * time.Minute)
		for ip, timestamps := range s.rateCache {
			valid := timestamps[:0]
			for _, t := range timestamps {
				if t.After(cutoff) {
					valid = append(valid, t)
				}
			}
			if len(valid) == 0 {
				delete(s.rateCache, ip)
			} else {
				s.rateCache[ip] = valid
			}
		}
		s.rateMu.Unlock()
	}
}

// --- Helpers ---

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
