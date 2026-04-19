package handler

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/thinkycx/blog-helper/internal/service"
)

// CommentHandler handles comment API requests.
type CommentHandler struct {
	svc *service.CommentService
}

// NewCommentHandler creates a new comment handler.
func NewCommentHandler(svc *service.CommentService) *CommentHandler {
	return &CommentHandler{svc: svc}
}

const commenterCookieName = "_bh_commenter"

// getCommenterToken reads the commenter token from cookie.
func getCommenterToken(r *http.Request) string {
	c, err := r.Cookie(commenterCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// setCommenterCookie writes the commenter token cookie on the response.
func setCommenterCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     commenterCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   365 * 24 * 3600, // 1 year
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// --- Public API handlers ---

// HandleGetComments handles GET /api/v1/comments?slug=&site_id=
func (h *CommentHandler) HandleGetComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	slug := r.URL.Query().Get("slug")
	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}
	token := getCommenterToken(r)
	fingerprint := r.URL.Query().Get("fp")

	resp, err := h.svc.GetComments(r.Context(), siteID, slug, token, fingerprint)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: resp})
}

// postCommentRequest is the JSON body for POST /api/v1/comments.
type postCommentRequest struct {
	SiteID      string `json:"site_id"`
	PageSlug    string `json:"page_slug"`
	Email       string `json:"email"`
	Nickname    string `json:"nickname"`
	AvatarSeed  string `json:"avatar_seed"`
	BlogURL     string `json:"blog_url"`
	Bio         string `json:"bio"`
	Content     string `json:"content"`
	ParentID    *int64 `json:"parent_id"`
	Fingerprint string `json:"fingerprint"`
	// Anti-bot: proof of work
	Challenge string `json:"challenge"`
	Answer    string `json:"answer"`
}

// HandlePostComment handles POST /api/v1/comments
func (h *CommentHandler) HandlePostComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	var req postCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	if strings.TrimSpace(req.Content) == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "content is required")
		return
	}

	// Verify anti-bot challenge
	if !verifyChallenge(req.Challenge, req.Answer) {
		writeError(w, http.StatusBadRequest, "CHALLENGE_FAILED", "Anti-bot verification failed")
		return
	}

	siteID := req.SiteID
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	token := getCommenterToken(r)

	resp, err := h.svc.PostComment(r.Context(), &service.PostCommentRequest{
		SiteID:      siteID,
		PageSlug:    req.PageSlug,
		Token:       token,
		Email:       req.Email,
		Nickname:    req.Nickname,
		AvatarSeed:  req.AvatarSeed,
		BlogURL:     req.BlogURL,
		Bio:         req.Bio,
		Content:     req.Content,
		ParentID:    req.ParentID,
		IP:          r.RemoteAddr,
		UserAgent:   r.Header.Get("User-Agent"),
		Fingerprint: req.Fingerprint,
	})
	if err != nil {
		if strings.Contains(err.Error(), "rate limit") {
			writeError(w, http.StatusTooManyRequests, "RATE_LIMIT", err.Error())
			return
		}
		if strings.Contains(err.Error(), "required") {
			writeError(w, http.StatusBadRequest, "MISSING_FIELD", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	// Set HttpOnly cookie so subsequent requests carry the token
	if resp.Token != "" {
		setCommenterCookie(w, resp.Token)
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: resp})
}

// HandleLookupCommenter handles GET /api/v1/commenter/lookup?email=
func (h *CommentHandler) HandleLookupCommenter(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	email := r.URL.Query().Get("email")
	if email == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "email is required")
		return
	}

	commenter, err := h.svc.LookupCommenter(r.Context(), email)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	if commenter == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No commenter with this email")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: commenter})
}

// updateProfileRequest is the JSON body for PUT /api/v1/commenter/profile.
type updateProfileRequest struct {
	Nickname   string `json:"nickname"`
	AvatarSeed string `json:"avatar_seed"`
	BlogURL    string `json:"blog_url"`
	Bio        string `json:"bio"`
}

// HandleUpdateProfile handles POST /api/v1/commenter/profile
func (h *CommentHandler) HandleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	token := getCommenterToken(r)
	if token == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing commenter token")
		return
	}

	var req updateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	updated, err := h.svc.UpdateProfile(r.Context(), token, req.Nickname, req.AvatarSeed, req.BlogURL, req.Bio)
	if err != nil {
		if strings.Contains(err.Error(), "invalid token") {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid token")
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: updated})
}

// HandleCommentCounts handles GET /api/v1/comments/count?site_id=&slugs=slug1,slug2
func (h *CommentHandler) HandleCommentCounts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}
	slugsParam := r.URL.Query().Get("slugs")
	if slugsParam == "" {
		writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: []interface{}{}})
		return
	}

	slugs := strings.Split(slugsParam, ",")
	counts, err := h.svc.GetCommentCounts(r.Context(), siteID, slugs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: counts})
}

// reactRequest is the JSON body for POST /api/v1/comments/react.
type reactRequest struct {
	CommentID   int64  `json:"comment_id"`
	Emoji       string `json:"emoji"`
	Fingerprint string `json:"fingerprint"`
	Action      string `json:"action"` // "add" or "remove"
}

// HandleReact handles POST /api/v1/comments/react
func (h *CommentHandler) HandleReact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	var req reactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	if req.Fingerprint == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "fingerprint is required")
		return
	}
	if req.Emoji == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "emoji is required")
		return
	}

	if err := h.svc.ReactToComment(r.Context(), req.CommentID, req.Emoji, req.Fingerprint, req.Action); err != nil {
		writeError(w, http.StatusBadRequest, "REACT_ERROR", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: "ok"})
}

// HandleRecentComments handles GET /api/v1/comments/recent?site_id=&limit=
func (h *CommentHandler) HandleRecentComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}
	limit := 5
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 20 {
		limit = l
	}

	comments, err := h.svc.GetRecentComments(r.Context(), siteID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: comments})
}

// HandleHotComments handles GET /api/v1/comments/hot?site_id=&limit=
func (h *CommentHandler) HandleHotComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}
	limit := 5
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 20 {
		limit = l
	}

	comments, err := h.svc.GetHotComments(r.Context(), siteID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: comments})
}

// --- Page reactions ---

// pageReactRequest is the JSON body for POST /api/v1/page/react.
type pageReactRequest struct {
	SiteID      string `json:"site_id"`
	PageSlug    string `json:"page_slug"`
	Emoji       string `json:"emoji"`
	Fingerprint string `json:"fingerprint"`
	Action      string `json:"action"` // "add" or "remove"
}

// HandlePageReact handles POST /api/v1/page/react
func (h *CommentHandler) HandlePageReact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	var req pageReactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	if req.Fingerprint == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "fingerprint is required")
		return
	}
	if req.Emoji == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "emoji is required")
		return
	}
	if req.PageSlug == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "page_slug is required")
		return
	}

	siteID := req.SiteID
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	if err := h.svc.ReactToPage(r.Context(), siteID, req.PageSlug, req.Emoji, req.Fingerprint, req.Action); err != nil {
		writeError(w, http.StatusBadRequest, "REACT_ERROR", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: "ok"})
}

// HandlePageReactions handles GET /api/v1/page/reactions?slug=&site_id=&fp=
func (h *CommentHandler) HandlePageReactions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	slug := r.URL.Query().Get("slug")
	if slug == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "slug is required")
		return
	}
	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}
	fingerprint := r.URL.Query().Get("fp")

	resp, err := h.svc.GetPageReactions(r.Context(), siteID, slug, fingerprint)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: resp})
}

// --- Dashboard (admin) handlers ---

// HandlePendingComments handles GET /api/v1/comments/pending?site_id=
func (h *CommentHandler) HandlePendingComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	comments, err := h.svc.GetPendingComments(r.Context(), siteID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: comments})
}

// HandleApproveComment handles POST /api/v1/comments/approve?id=
func (h *CommentHandler) HandleApproveComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PARAM", "Invalid comment id")
		return
	}

	if err := h.svc.ApproveComment(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: "approved"})
}

// HandleRejectComment handles POST /api/v1/comments/reject?id=
func (h *CommentHandler) HandleRejectComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PARAM", "Invalid comment id")
		return
	}

	if err := h.svc.RejectComment(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: "rejected"})
}

// HandleDeleteComment handles POST /api/v1/comments/delete?id=
func (h *CommentHandler) HandleDeleteComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PARAM", "Invalid comment id")
		return
	}

	if err := h.svc.DeleteComment(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: "deleted"})
}

// HandleAllComments handles GET /api/v1/comments/all?site_id=&limit=&offset=
func (h *CommentHandler) HandleAllComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	siteID := r.URL.Query().Get("site_id")
	if siteID == "" {
		siteID = extractSiteID(r)
	}
	limit := 20
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}
	offset := 0
	if o, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && o >= 0 {
		offset = o
	}

	comments, total, err := h.svc.GetAllComments(r.Context(), siteID, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: map[string]interface{}{
		"comments": comments,
		"total":    total,
		"limit":    limit,
		"offset":   offset,
	}})
}

// adminReplyRequest is the JSON body for POST /api/v1/comments/admin-reply.
type adminReplyRequest struct {
	SiteID   string `json:"site_id"`
	PageSlug string `json:"page_slug"`
	Content  string `json:"content"`
	ParentID *int64 `json:"parent_id"`
}

// HandleAdminReply handles POST /api/v1/comments/admin-reply
func (h *CommentHandler) HandleAdminReply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	var req adminReplyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	if strings.TrimSpace(req.Content) == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "content is required")
		return
	}
	if req.PageSlug == "" {
		writeError(w, http.StatusBadRequest, "MISSING_FIELD", "page_slug is required")
		return
	}

	siteID := req.SiteID
	if siteID == "" {
		siteID = extractSiteID(r)
	}

	comment, err := h.svc.AdminReply(r.Context(), siteID, req.PageSlug, req.Content, req.ParentID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: comment})
}

// HandleAllCommenters handles GET /api/v1/commenters/all?limit=&offset=
func (h *CommentHandler) HandleAllCommenters(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}

	limit := 20
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}
	offset := 0
	if o, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && o >= 0 {
		offset = o
	}

	commenters, total, err := h.svc.GetAllCommenters(r.Context(), limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: map[string]interface{}{
		"commenters": commenters,
		"total":      total,
		"limit":      limit,
		"offset":     offset,
	}})
}

// HandleGetCommentMode handles GET /api/v1/comments/mode
func (h *CommentHandler) HandleGetCommentMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: map[string]string{"mode": h.svc.CommentMode()}})
}

// setCommentModeRequest is the JSON body for POST /api/v1/comments/mode.
type setCommentModeRequest struct {
	Mode string `json:"mode"`
}

// HandleSetCommentMode handles POST /api/v1/comments/mode
func (h *CommentHandler) HandleSetCommentMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is allowed")
		return
	}

	var req setCommentModeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
		return
	}

	if err := h.svc.SetCommentMode(req.Mode); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_MODE", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: map[string]string{"mode": req.Mode}})
}

// HandleCommentConfig handles GET /api/v1/comments/config
// Returns whether comments are enabled for this site (used by SDK auto-detect).
func (h *CommentHandler) HandleCommentConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}
	mode := h.svc.CommentMode()
	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: map[string]interface{}{
		"enabled": mode != "off",
		"mode":    mode,
	}})
}

// HandleGetChallenge handles GET /api/v1/comments/challenge
// Returns a random challenge string for anti-bot proof-of-work.
func (h *CommentHandler) HandleGetChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Failed to generate challenge")
		return
	}
	challenge := fmt.Sprintf("bh_%s", hex.EncodeToString(b))
	writeJSON(w, http.StatusOK, apiResponse{OK: true, Data: map[string]string{
		"challenge":  challenge,
		"difficulty": "0000",
	}})
}

// --- Anti-bot challenge ---
// Lightweight proof-of-work: server sends a challenge prefix, client must find a suffix
// such that SHA-256(prefix + suffix) starts with "0000". This runs in a brief JS loop
// (~50-200ms on modern browsers) proving the client has a real JS environment.

func verifyChallenge(challenge, answer string) bool {
	if challenge == "" || answer == "" {
		return false
	}
	return verifyChallengeSHA(challenge, answer)
}

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func verifyChallengeSHA(challenge, answer string) bool {
	hash := sha256hex(challenge + answer)
	return strings.HasPrefix(hash, "0000")
}
