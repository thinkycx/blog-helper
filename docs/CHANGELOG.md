# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Share timestamp on cards: local time with timezone offset, bottom-right
  (does not affect the centered @host footer)
- Uniform 3:4 baseline aspect ratio for share cards: short quotes render as a
  standard 1080x1440 card (content top, footer pinned to bottom); long
  passages still grow into long images

### Changed
- Default share options: font 宋体 (serif) first; option order — styles
  默认/宁静风/引用风/日历风/竹简风, backgrounds 白/夜/米/灰/绿
- Fix stale `classic` fallback theme key in `loadShareOpts` (first open showed
  no active style chip)

### Added
- QR center avatar on share cards (error-correction level H, ~22% size with white ring —
  same approach as WeChat/Alipay QR logos; scannability unaffected). Avatar path
  auto-probes `/asset/img/avator.png` then `.jpg`, overridable via `features.shareAvatar`

### Changed
- Inline comments are now independent of the comment section: pages using another comment
  system (e.g. giscus) get the selection menu with copy/share only (no comment action);
  deep links still work there

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
