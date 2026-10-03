# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [v20261003] — 2026-10-03

### Added
- **Inline comments (text-anchored)**: select any passage to comment on it.
  - `comments.anchor` column (JSON TextQuoteSelector-style: `exact`/`prefix`/`suffix`/`start`/`end`), backward-compatible migration, empty = whole-page comment
  - Content-addressed resolution: position verify → prefix+exact+suffix search → exact search; degrades to quote-only when the passage no longer exists
  - Layout-safe per-text-node highlight painting, overlapping passages merged, dashed pending underline while composing
  - Selection menu (comment / copy / share) following the mouse position
  - Anchor popover below the passage, auto-opens the form for passages without comments, Esc/outside-click close
  - Deep links `#bh-{start}-{end}` scroll + flash to the exact passage, auto-expanding collapsed `<details>`
- **Share cards**: canvas quote card with QR deep link and centered `@{hostname}` footer.
  - Paragraph-aware long-image rendering (up to 80 lines)
  - 5 styles: plain / quote / calendar / serene (deep-ocean banner) / bamboo (traditional vertical, right-to-left)
  - 5 CJK fonts with availability probing — fonts the device cannot render are hidden instead of silently falling back
  - 5 background colors; copy image / copy link / download / native share (`navigator.share`)
  - Render options persisted in `localStorage`
- Vendored `qrcode-generator` 1.4.4 (MIT) as `sdk/lib/qrcode.min.js`, lazy-loaded like marked.js

### Fixed
- Comment section no longer escapes the page column when `postContainer` resolves to a top-level
  wrapper (e.g. md2site `.container`) — the section is now appended inside the container

## [v20260810] — 2026-08-10

### Added
- Popular API `prefix` / `exclude` filtering and localStorage cache (`popularCacheTTL`)
- `showListAll` feature: batch page reactions API + list stats (UV / PV / likes per item)

## [v20260420] — 2026-04-20

### Added
- Comment management dashboard: All / Pending / Commenters tabs, admin reply (Markdown), runtime comment-mode switch
- Commenter identity fixes, engagement stats on dashboard

## [v20260418] — 2026-04-18

### Added
- Comment system: email-based identity with cookie token, threaded replies, Markdown
  (write/preview), emoji reactions on comments and pages, profile editing
- Per-site comment control via SDK `showComments` (`true` / `"auto"` / `false`)
- Anti-abuse: Proof-of-Work challenge, 5 comments/IP/minute rate limit, honeypot field

## [v20260412] — 2026-04-12

### Added
- Analytics dashboard (password-protected): trend charts with time ranges, referrers,
  visitors, platforms, raw access logs, article drill-down
- Sub-daily trends, version display, dashboard refresh stabilization

## [v20260406] — 2026-04-06

### Added
- Initial release: PV/UV tracking with fingerprint dedup, batch stats, popular articles,
  multi-site support (`site_id` isolated by hostname), zero-config SDK
