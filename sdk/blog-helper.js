/**
 * Blog Helper SDK
 * Lightweight, zero-dependency page view tracker for static blogs.
 *
 * Usage (zero-config — auto-detects current domain):
 *   <script src="blog-helper.js" defer></script>
 *
 * Or with explicit config:
 *   <script>
 *   window.BlogHelperConfig = {
 *     apiBase: "https://your-domain.com/api/v1/analytics"
 *   };
 *   </script>
 *   <script src="blog-helper.js" defer></script>
 *
 * @version 1.1.0
 * @license MIT
 */
;(function () {
  "use strict";

  // ============================================================
  // 1. Configuration
  // ============================================================

  var DEFAULTS = {
    apiBase: "",
    siteId: "",      // Auto-detected from location.hostname if empty
    pageType: "auto", // "auto" | "list" | "post" | "none"
    selectors: {
      listItems: ".post-item",
      listItemLink: "a",
      postContainer: "article.post",
      postTitle: "article.post h1",
      postMeta: ".post-header time, article.post time",
      sidebarMount: "#ba-popular-mount",
    },
    features: {
      reportPV: true,
      showListPV: true,
      showPostStats: true,
      showPopular: true,
      popularLimit: 8,
      popularPeriod: "30d",
      showActive: false,
      showTrend: false,
      showReferrers: false,
      activeMinutes: 30,
      trendDays: 30,
      referrersDays: 30,
      referrersLimit: 10,
      showComments: "auto",
    },
    pvLabel: "阅读",
    uvLabel: "观众",
    separator: " | ",
    popularTitle: "Hot Posts",
    activeLabel: "人最近在访问",
    trendTitle: "访问趋势",
    referrersTitle: "来源",
    timeout: 5000,
  };

  function mergeDeep(target, source) {
    if (!source) return target;
    var result = {};
    for (var key in target) {
      if (target.hasOwnProperty(key)) {
        if (
          typeof target[key] === "object" &&
          target[key] !== null &&
          !Array.isArray(target[key])
        ) {
          result[key] = mergeDeep(target[key], source[key]);
        } else {
          result[key] = source.hasOwnProperty(key) ? source[key] : target[key];
        }
      }
    }
    // Include any extra keys from source
    for (var key in source) {
      if (source.hasOwnProperty(key) && !target.hasOwnProperty(key)) {
        result[key] = source[key];
      }
    }
    return result;
  }

  // Read config from window.BlogHelperConfig or <script> data attributes
  function loadConfig() {
    var userConfig = window.BlogHelperConfig || window.BlogAnalyticsConfig || {};

    // Also check data attributes on the <script> tag
    var scripts = document.querySelectorAll('script[src*="blog-helper"]');
    if (scripts.length > 0) {
      var script = scripts[scripts.length - 1];
      if (script.dataset.api && !userConfig.apiBase) {
        userConfig.apiBase = script.dataset.api;
      }
    }

    return mergeDeep(DEFAULTS, userConfig);
  }

  // ============================================================
  // 2. Fingerprint Module
  // ============================================================

  var COOKIE_NAME = "_bh_fp";
  var COOKIE_MAX_AGE = 10 * 365 * 24 * 60 * 60; // ~10 years (effectively permanent)
  var _fingerprintCache = null;

  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value) {
    document.cookie =
      name + "=" + encodeURIComponent(value) +
      "; path=/; max-age=" + COOKIE_MAX_AGE +
      "; SameSite=Lax";
  }

  function collectSignals() {
    var signals = [];
    var s = window.screen || {};
    signals.push((s.width || 0) + "x" + (s.height || 0));
    signals.push(String(s.colorDepth || 0));
    signals.push(navigator.language || "");
    signals.push(navigator.platform || "");
    signals.push(String(navigator.hardwareConcurrency || 0));
    signals.push(String(new Date().getTimezoneOffset()));

    // Lightweight canvas fingerprint
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#f60";
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = "#069";
      ctx.font = "11px Arial";
      ctx.fillText("BA", 2, 12);
      signals.push(canvas.toDataURL());
    } catch (e) {
      signals.push("no-canvas");
    }

    return signals.join("|");
  }

  function sha256(str) {
    if (window.crypto && window.crypto.subtle) {
      var buffer = new TextEncoder().encode(str);
      return window.crypto.subtle.digest("SHA-256", buffer).then(function (hash) {
        var hexParts = [];
        var view = new Uint8Array(hash);
        for (var i = 0; i < view.length; i++) {
          hexParts.push(("00" + view[i].toString(16)).slice(-2));
        }
        return hexParts.join("");
      });
    }
    // Fallback: simple djb2 hash
    return Promise.resolve(djb2(str));
  }

  function djb2(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return (hash >>> 0).toString(16);
  }

  function getFingerprint() {
    if (_fingerprintCache) return Promise.resolve(_fingerprintCache);

    // 1. Try reading from cookie
    var stored = getCookie(COOKIE_NAME);
    if (stored) {
      _fingerprintCache = stored;
      // Refresh cookie expiry on every visit
      setCookie(COOKIE_NAME, stored);
      return Promise.resolve(stored);
    }

    // 2. First visit: compute fingerprint, persist to cookie
    var raw = collectSignals();
    return sha256(raw).then(function (hash) {
      _fingerprintCache = hash;
      setCookie(COOKIE_NAME, hash);
      return hash;
    });
  }

  // ============================================================
  // 3. API Client Module
  // ============================================================

  function apiRequest(config, method, path, body) {
    var url = config.apiBase.replace(/\/+$/, "") + path;
    var opts = {
      method: method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) {
      opts.body = JSON.stringify(body);
    }

    // Timeout via AbortController
    var controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    if (controller) {
      opts.signal = controller.signal;
      setTimeout(function () {
        controller.abort();
      }, config.timeout);
    }

    return fetch(url, opts)
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.ok) return data.data;
        throw new Error(data.error ? data.error.message : "API error");
      })
      .catch(function (err) {
        // Fail silently — blog must work even if API is down
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[BlogHelper]", err.message || err);
        }
        return null;
      });
  }

  function apiReport(config, slug, title, fingerprint) {
    return apiRequest(config, "POST", "/report", {
      site_id: config.siteId,
      page_slug: slug,
      page_title: title,
      fingerprint: fingerprint,
      referrer: document.referrer || "",
    });
  }

  function apiBatchStats(config, slugs) {
    return apiRequest(config, "POST", "/stats/batch", {
      site_id: config.siteId,
      slugs: slugs,
    });
  }

  function apiPopular(config, limit, period) {
    return apiRequest(
      config,
      "GET",
      "/popular?limit=" + limit + "&period=" + period + "&site_id=" + encodeURIComponent(config.siteId)
    );
  }

  function apiActive(config, minutes) {
    return apiRequest(
      config,
      "GET",
      "/active?minutes=" + minutes + "&site_id=" + encodeURIComponent(config.siteId)
    );
  }

  function apiTrend(config, days) {
    return apiRequest(
      config,
      "GET",
      "/trend?days=" + days + "&site_id=" + encodeURIComponent(config.siteId)
    );
  }

  function apiReferrers(config, days, limit) {
    return apiRequest(
      config,
      "GET",
      "/referrers?days=" + days + "&limit=" + limit + "&site_id=" + encodeURIComponent(config.siteId)
    );
  }

  // ============================================================
  // 4. Page Detector Module
  // ============================================================

  function detectPageType(config) {
    if (config.pageType !== "auto") return config.pageType;
    var sel = config.selectors;
    if (document.querySelector(sel.postContainer)) return "post";
    if (document.querySelectorAll(sel.listItems).length > 0) return "list";
    return "unknown";
  }

  function getCurrentSlug() {
    // Try canonical link first
    var canonical = document.querySelector('link[rel="canonical"]');
    if (canonical && canonical.href) {
      try {
        return normalizeSlug(new URL(canonical.href).pathname);
      } catch (e) {}
    }
    return normalizeSlug(window.location.pathname);
  }

  function getCurrentTitle() {
    // Try <h1> in post first, then document.title
    var h1 = document.querySelector("article.post h1, article.page h1");
    if (h1) return h1.textContent.trim();
    return document.title || "";
  }

  function normalizeSlug(path) {
    path = path.replace(/\/+$/, "") || "/";
    return path;
  }

  // ============================================================
  // 5. Renderer Module
  // ============================================================

  function injectStyles() {
    if (document.getElementById("bh-css")) return;
    var link = document.createElement("link");
    link.id = "bh-css";
    link.rel = "stylesheet";
    var myScript = document.querySelector('script[src*="blog-helper"]');
    var baseDir = myScript ? myScript.src.replace(/[^\/]+$/, '') : 'asset/js/';
    link.href = baseDir + "blog-helper.css";
    document.head.appendChild(link);
  }

  function renderListPV(config, statsMap) {
    if (!statsMap) return;
    var sel = config.selectors;
    var items = document.querySelectorAll(sel.listItems);

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var link = item.querySelector(sel.listItemLink);
      if (!link || !link.href) continue;

      var slug;
      try {
        slug = normalizeSlug(new URL(link.href).pathname);
      } catch (e) {
        continue;
      }

      var stats = statsMap[slug];
      var pv = item.querySelector(".ba-pv");

      if (stats && pv) {
        // Populate existing placeholder and fade in
        pv.textContent = config.pvLabel + " " + stats.pv;
        pv.classList.add("ba-pv-ready");
      } else if (pv && !stats) {
        // No data — collapse placeholder so it takes no space
        pv.style.display = "none";
      }
    }
  }

  function renderPostStats(config, pv, uv) {
    var sel = config.selectors;
    var meta = document.querySelector(sel.postMeta);
    if (!meta) {
      // Fallback: try inserting after the post title
      meta = document.querySelector(
        sel.postTitle || config.selectors.postContainer + " h1"
      );
    }
    if (!meta) return;

    // Don't render twice
    if (document.querySelector(".ba-stats")) return;

    var span = document.createElement("span");
    span.className = "ba-stats";
    span.innerHTML =
      config.uvLabel + ' ' + uv +
      '<span class="ba-separator">' + config.separator + '</span>' +
      config.pvLabel + ' ' + pv;

    meta.parentNode.insertBefore(span, meta.nextSibling);
  }

  function renderPopular(config, articles) {
    if (!articles || articles.length === 0) return;

    var mount = document.querySelector(config.selectors.sidebarMount);
    if (!mount) return;

    // Wrap in sidebar-section + sidebar-title to match TOC layout
    var html = '<div class="sidebar-section ba-popular">';
    html += '<div class="sidebar-title">' + config.popularTitle + '</div>';
    html += "<ul>";
    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      var title = a.page_title || a.page_slug;
      html +=
        "<li>" +
        '<a href="' +
        escapeHtml(a.page_slug) +
        '" title="' +
        escapeHtml(title) +
        '">' +
        escapeHtml(title) +
        "</a>" +
        '<span class="ba-count">' + a.pv + '</span>' +
        "</li>";
    }
    html += "</ul></div>";
    mount.innerHTML = html;
  }

  function renderActive(config, data) {
    if (!data || data.count === 0) return;

    var mount = document.querySelector(config.selectors.sidebarMount);
    if (!mount) return;

    var el = document.createElement("div");
    el.className = "ba-active";
    el.innerHTML =
      '<span class="ba-active-dot"></span>' +
      '<span class="ba-active-count">' + data.count + '</span> ' +
      escapeHtml(config.activeLabel);
    mount.parentNode.insertBefore(el, mount);
  }

  function renderTrend(config, data) {
    if (!data || data.length === 0) return;

    var mount = document.querySelector(config.selectors.sidebarMount);
    if (!mount) return;

    var maxPV = 1;
    var totalPV = 0;
    var totalUV = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i].pv > maxPV) maxPV = data[i].pv;
      totalPV += data[i].pv;
      totalUV += data[i].uv;
    }

    var html = '<div class="sidebar-section ba-trend">';
    html += '<div class="sidebar-title">' + escapeHtml(config.trendTitle) + '</div>';
    html += '<div class="ba-trend-chart">';
    for (var i = 0; i < data.length; i++) {
      var pct = Math.max((data[i].pv / maxPV) * 100, 5);
      html += '<div class="ba-trend-bar" style="height:' + pct + '%" title="' +
        data[i].date + ': ' + data[i].pv + ' PV / ' + data[i].uv + ' UV"></div>';
    }
    html += '</div>';
    html += '<div class="ba-trend-summary">' + data.length + '天: ' +
      totalPV.toLocaleString() + ' PV / ' + totalUV.toLocaleString() + ' UV</div>';
    html += '</div>';

    mount.parentNode.insertBefore(
      createElementFromHTML(html),
      mount
    );
  }

  function renderReferrers(config, data) {
    if (!data || data.length === 0) return;

    var mount = document.querySelector(config.selectors.sidebarMount);
    if (!mount) return;

    var html = '<div class="sidebar-section ba-referrers">';
    html += '<div class="sidebar-title">' + escapeHtml(config.referrersTitle) + '</div>';
    html += '<ul>';
    for (var i = 0; i < data.length; i++) {
      html += '<li><span>' + escapeHtml(data[i].domain) + '</span>' +
        '<span class="ba-count">' + data[i].count + '</span></li>';
    }
    html += '</ul></div>';

    // Insert after popular section
    var popular = mount.querySelector(".ba-popular");
    if (popular) {
      popular.parentNode.insertBefore(createElementFromHTML(html), popular.nextSibling);
    } else {
      mount.appendChild(createElementFromHTML(html));
    }
  }

  function createElementFromHTML(htmlString) {
    var div = document.createElement("div");
    div.innerHTML = htmlString.trim();
    return div.firstChild;
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ============================================================
  // 6. Comment Module
  // ============================================================

  var COMMENTER_COOKIE = "_bh_commenter";

  function getCommenterToken() {
    return getCookie(COMMENTER_COOKIE);
  }

  function setCommenterToken(token) {
    document.cookie =
      COMMENTER_COOKIE + "=" + encodeURIComponent(token) +
      "; path=/; max-age=" + (365 * 24 * 3600) +
      "; SameSite=Lax";
  }

  // Comment API helpers — use the base URL (not analytics path)
  function commentApiBase(config) {
    // apiBase is like /api/v1/analytics, we need /api/v1
    return config.apiBase.replace(/\/analytics\/?$/, "");
  }

  function apiGetComments(config, slug, fp) {
    var base = commentApiBase(config);
    var url = base + "/comments?slug=" + encodeURIComponent(slug) +
      "&site_id=" + encodeURIComponent(config.siteId);
    if (fp) url += "&fp=" + encodeURIComponent(fp);
    return fetch(url, {
      credentials: "same-origin",
    }).then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : null; })
      .catch(function () { return null; });
  }

  function apiCommentCounts(config, slugs) {
    var base = commentApiBase(config);
    return fetch(base + "/comments/count?site_id=" + encodeURIComponent(config.siteId) +
      "&slugs=" + encodeURIComponent(slugs.join(",")), {
      credentials: "same-origin",
    }).then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : null; })
      .catch(function () { return null; });
  }

  function apiReact(config, commentID, emoji, fingerprint, action) {
    var base = commentApiBase(config);
    return fetch(base + "/comments/react", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ comment_id: commentID, emoji: emoji, fingerprint: fingerprint, action: action }),
    }).then(function (r) { return r.json(); })
      .then(function (d) { return d.ok; })
      .catch(function () { return false; });
  }

  function apiRecentComments(config, limit) {
    var base = commentApiBase(config);
    return fetch(base + "/comments/recent?site_id=" + encodeURIComponent(config.siteId) +
      "&limit=" + (limit || 5), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : null; })
      .catch(function () { return null; });
  }

  function apiHotComments(config, limit) {
    var base = commentApiBase(config);
    return fetch(base + "/comments/hot?site_id=" + encodeURIComponent(config.siteId) +
      "&limit=" + (limit || 5), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : null; })
      .catch(function () { return null; });
  }

  function apiPageReact(config, slug, emoji, fingerprint, action) {
    var base = commentApiBase(config);
    return fetch(base + "/page/react", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ site_id: config.siteId, page_slug: slug, emoji: emoji, fingerprint: fingerprint, action: action }),
    }).then(function (r) { return r.json(); })
      .then(function (d) { return d.ok; })
      .catch(function () { return false; });
  }

  function apiPageReactions(config, slug, fp) {
    var base = commentApiBase(config);
    var url = base + "/page/reactions?slug=" + encodeURIComponent(slug) +
      "&site_id=" + encodeURIComponent(config.siteId);
    if (fp) url += "&fp=" + encodeURIComponent(fp);
    return fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : null; })
      .catch(function () { return null; });
  }

  function apiLookupCommenter(config, email) {
    var base = commentApiBase(config);
    return fetch(base + "/commenter/lookup?email=" + encodeURIComponent(email), {
      credentials: "same-origin",
    }).then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : null; })
      .catch(function () { return null; });
  }

  function apiGetChallenge(config) {
    var base = commentApiBase(config);
    return fetch(base + "/comments/challenge", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : null; })
      .catch(function () { return null; });
  }

  function apiPostComment(config, body) {
    var base = commentApiBase(config);
    return fetch(base + "/comments/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: { message: "Network error" } }; });
  }

  // Proof-of-work solver: find nonce such that SHA-256(challenge + nonce) starts with "0000"
  function solveChallenge(challenge) {
    return new Promise(function (resolve) {
      var nonce = 0;
      function work() {
        var batch = 1000;
        for (var i = 0; i < batch; i++) {
          var attempt = challenge + nonce;
          // Use sync SHA-256 via SubtleCrypto is async, so we use a chunked approach
          nonce++;
        }
        // Actually do it with crypto.subtle
        tryNonces(challenge, nonce - batch, batch).then(function (found) {
          if (found !== null) {
            resolve(String(found));
          } else {
            setTimeout(work, 0); // yield to UI thread
          }
        });
      }
      work();
    });
  }

  function tryNonces(challenge, startNonce, count) {
    // Try a batch of nonces
    var promises = [];
    for (var i = 0; i < count; i++) {
      promises.push(checkNonce(challenge, startNonce + i));
    }
    return Promise.all(promises).then(function (results) {
      for (var i = 0; i < results.length; i++) {
        if (results[i]) return startNonce + i;
      }
      return null;
    });
  }

  function checkNonce(challenge, nonce) {
    var input = challenge + nonce;
    if (window.crypto && window.crypto.subtle) {
      var buffer = new TextEncoder().encode(input);
      return window.crypto.subtle.digest("SHA-256", buffer).then(function (hash) {
        var view = new Uint8Array(hash);
        // Check if first 2 bytes are 0 (= "0000" hex prefix)
        return view[0] === 0 && view[1] === 0;
      });
    }
    // Fallback: always pass (no real PoW without crypto)
    return Promise.resolve(nonce === 0);
  }

  // Generate simple SVG avatar from seed
  function generateAvatar(seed, size) {
    size = size || 40;
    var hash = 0;
    for (var i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    var hue = Math.abs(hash) % 360;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 40 40">' +
      '<rect width="40" height="40" rx="8" fill="hsl(' + hue + ',60%,75%)"/>' +
      '<text x="20" y="26" text-anchor="middle" fill="white" font-size="18" font-family="sans-serif">' +
      seed.charAt(0).toUpperCase() + '</text></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  // Format time — relative for recent, exact for older. short=true for sidebar (compact)
  function formatTime(dateStr, short) {
    if (!dateStr) return "";
    // Handle both "2024-01-15 14:30:00" and "2024-01-15T14:30:00Z"
    var s = dateStr.indexOf('T') === -1 ? dateStr.replace(' ', 'T') + 'Z' : dateStr;
    var date = new Date(s);
    var now = new Date();
    var diff = Math.floor((now - date) / 1000);
    if (diff < 60) return short ? "刚刚" : diff + " 秒前";
    if (diff < 3600) return Math.floor(diff / 60) + (short ? "分钟前" : " 分钟前");
    if (diff < 86400) return Math.floor(diff / 3600) + (short ? "小时前" : " 小时前");
    if (short) {
      if (diff < 2592000) return Math.floor(diff / 86400) + "天前";
      return (date.getMonth() + 1) + "/" + date.getDate();
    }
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    return y + '-' + m + '-' + d + ' ' + hh + ':' + mm;
  }

  // --- Markdown rendering via marked.js (lazy-loaded from local asset) ---

  var _markedReady = false;
  var _markedLoading = false;
  var _markedCallbacks = [];

  function loadMarked(cb) {
    if (_markedReady && window.marked) { cb(); return; }
    _markedCallbacks.push(cb);
    if (_markedLoading) return;
    _markedLoading = true;
    var script = document.createElement("script");
    // Load from local asset (same directory as blog-helper.js) to avoid CDN supply-chain risk
    var myScript = document.querySelector('script[src*="blog-helper"]');
    var baseDir = myScript ? myScript.src.replace(/[^\/]+$/, '') : 'asset/js/';
    script.src = baseDir + "marked.min.js";
    script.onload = function () {
      _markedReady = true;
      // Configure marked for safe comment rendering
      if (window.marked) {
        window.marked.setOptions({
          breaks: true,
          gfm: true,
        });
      }
      for (var i = 0; i < _markedCallbacks.length; i++) _markedCallbacks[i]();
      _markedCallbacks = [];
    };
    script.onerror = function () {
      _markedLoading = false;
      for (var i = 0; i < _markedCallbacks.length; i++) _markedCallbacks[i]();
      _markedCallbacks = [];
    };
    document.head.appendChild(script);
  }

  // Whitelist-based HTML sanitizer for Markdown output
  function sanitizeHTML(html) {
    var div = document.createElement("div");
    div.innerHTML = html;
    var ALLOWED_TAGS = {
      P:1, BR:1, STRONG:1, EM:1, DEL:1, A:1, CODE:1, PRE:1, BLOCKQUOTE:1,
      UL:1, OL:1, LI:1, IMG:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, HR:1,
      TABLE:1, THEAD:1, TBODY:1, TR:1, TH:1, TD:1, INPUT:1,
    };
    var ALLOWED_ATTRS = {
      A: ["href", "title", "target", "rel"],
      IMG: ["src", "alt", "title"],
      INPUT: ["type", "checked", "disabled"],
      TD: ["align"], TH: ["align"],
    };
    function clean(node) {
      var children = [].slice.call(node.childNodes);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType === 1) { // Element
          if (!ALLOWED_TAGS[child.tagName]) {
            // Replace with text content
            var text = document.createTextNode(child.textContent);
            node.replaceChild(text, child);
          } else {
            // Strip disallowed attributes
            var allowed = ALLOWED_ATTRS[child.tagName] || [];
            var attrs = [].slice.call(child.attributes);
            for (var j = 0; j < attrs.length; j++) {
              if (allowed.indexOf(attrs[j].name) === -1) {
                child.removeAttribute(attrs[j].name);
              }
            }
            // Sanitize href: block javascript: URLs
            if (child.tagName === "A") {
              var href = (child.getAttribute("href") || "").trim().toLowerCase();
              if (href.indexOf("javascript:") === 0 || href.indexOf("data:") === 0) {
                child.setAttribute("href", "#");
              }
              child.setAttribute("target", "_blank");
              child.setAttribute("rel", "noopener noreferrer");
            }
            if (child.tagName === "IMG") {
              var src = (child.getAttribute("src") || "").trim().toLowerCase();
              if (src.indexOf("javascript:") === 0 || src.indexOf("data:") === 0) {
                child.removeAttribute("src");
              }
            }
            // Only allow checkbox inputs (GFM task lists)
            if (child.tagName === "INPUT") {
              if (child.getAttribute("type") !== "checkbox") {
                node.removeChild(child);
                continue;
              }
              child.setAttribute("disabled", "");
            }
            clean(child);
          }
        }
      }
    }
    clean(div);
    return div.innerHTML;
  }

  function renderMarkdown(raw) {
    if (window.marked && window.marked.parse) {
      return sanitizeHTML(window.marked.parse(raw));
    }
    // Fallback: plain text with escaping
    return '<p>' + escapeHtml(raw).replace(/\n/g, '<br>') + '</p>';
  }

  // ============================================================
  // 6a-1. Page-level Reactions (heart for articles)
  // ============================================================

  function renderPageReactions(config, slug) {
    var container = document.querySelector(config.selectors.postContainer);
    if (!container) return;

    injectStyles();

    var bar = document.createElement("div");
    bar.className = "bh-page-reactions";
    // Insert after post-content (before gitalk/comments), fallback to append
    var postContent = container.querySelector(".post-content, .markdown-body");
    if (postContent) {
      postContent.parentNode.insertBefore(bar, postContent.nextSibling);
    } else {
      container.appendChild(bar);
    }

    // Initial render from API
    getFingerprint().then(function (fp) {
      return apiPageReactions(config, slug, fp);
    }).then(function (data) {
      if (!data) return;
      var reactions = data.reactions || [];
      var myReactions = data.my_reactions || [];
      var reactionMap = {};
      for (var i = 0; i < reactions.length; i++) {
        reactionMap[reactions[i].emoji] = reactions[i].count;
      }

      var emoji = "\u2764\uFE0F";
      var count = reactionMap[emoji] || 0;
      var active = myReactions.indexOf(emoji) !== -1;
      bar.innerHTML = '<button class="bh-page-react-btn' + (active ? ' bh-active' : '') +
        '" data-emoji="' + emoji + '" title="喜欢这篇文章">' +
        '<span class="bh-page-react-emoji">' + emoji + '</span>' +
        '<span class="bh-page-react-count">' + (count > 0 ? count : '') + '</span>' +
        '</button>';

      // Bind click with optimistic update
      var btn = bar.querySelector(".bh-page-react-btn");
      btn.addEventListener("click", function () {
        var isActive = btn.classList.contains("bh-active");
        var action = isActive ? "remove" : "add";

        // Optimistic UI update
        var countEl = btn.querySelector(".bh-page-react-count");
        var currentCount = parseInt(countEl.textContent) || 0;
        var newCount = action === "add" ? currentCount + 1 : Math.max(0, currentCount - 1);
        countEl.textContent = newCount > 0 ? newCount : "";
        btn.classList.toggle("bh-active");

        // Fire and forget
        getFingerprint().then(function (fp) {
          apiPageReact(config, slug, emoji, fp, action);
        });
      });
    });
  }

  function renderCommentSection(config, slug) {
    var container = document.querySelector(config.selectors.postContainer);
    if (!container) return;

    injectStyles();

    // Create comment section container
    var section = document.createElement("div");
    section.className = "bh-comments";
    section.innerHTML =
      '<div class="bh-comments-title">评论</div>' +
      '<div class="bh-comment-list"><div class="bh-no-comments">加载中...</div></div>' +
      '<div class="bh-comment-form-trigger"><button class="bh-write-comment-btn" type="button">写评论</button></div>' +
      '<div class="bh-comment-form" style="display:none"></div>';
    // Insert after the article element so comments are visually separate from post content.
    // Falls back to appending inside the container if insertAfter is not possible.
    if (container.nextSibling) {
      container.parentNode.insertBefore(section, container.nextSibling);
    } else {
      container.parentNode.appendChild(section);
    }

    // State
    var state = {
      comments: [],
      me: null,
      replyTo: null,
    };

    // "写评论" button shows form
    section.querySelector(".bh-write-comment-btn").addEventListener("click", function () {
      state.replyTo = null;
      showCommentForm(section, state, config, slug);
    });

    // Load marked.js + comments in parallel, render after both ready
    var markedPromise = new Promise(function (resolve) { loadMarked(resolve); });
    var commentsPromise = getFingerprint().then(function (fp) {
      return apiGetComments(config, slug, fp);
    });

    Promise.all([markedPromise, commentsPromise]).then(function (results) {
      var data = results[1];
      if (!data) {
        section.querySelector(".bh-comment-list").innerHTML =
          '<div class="bh-no-comments">评论加载失败</div>';
        return;
      }
      state.comments = data.comments || [];
      state.me = data.me || null;
      renderCommentList(section, state, config);
      // Scroll to comment if URL has #comment-{id}
      var hash = window.location.hash;
      if (hash && hash.indexOf("#comment-") === 0) {
        setTimeout(function () {
          var el = document.getElementById(hash.substring(1));
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("bh-comment-highlight");
            setTimeout(function () { el.classList.remove("bh-comment-highlight"); }, 4000);
          }
        }, 300);
      }
    });
  }

  function showCommentForm(section, state, config, slug) {
    var trigger = section.querySelector(".bh-comment-form-trigger");
    var form = section.querySelector(".bh-comment-form");
    if (trigger) trigger.style.display = "none";
    form.style.display = "";
    renderCommentForm(section, state, config, slug);
    if (state.me) {
      var textarea = form.querySelector("textarea");
      if (textarea) textarea.focus();
    } else {
      var emailInput = form.querySelector('input[name="email"]');
      if (emailInput) emailInput.focus();
    }
  }

  function hideCommentForm(section) {
    var trigger = section.querySelector(".bh-comment-form-trigger");
    var form = section.querySelector(".bh-comment-form");
    if (trigger) trigger.style.display = "";
    form.style.display = "none";
  }

  // Ensure blog_url has https:// protocol
  function normalizeBlogUrl(url) {
    if (!url) return '';
    url = url.trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url;
  }

  var REACTION_EMOJIS = [
    { emoji: "\u2764\uFE0F", label: "爱心" },
  ];

  function renderReactionButtons(c) {
    var reactions = c.reactions || [];
    var myReactions = c.my_reactions || [];
    var reactionMap = {};
    for (var i = 0; i < reactions.length; i++) {
      reactionMap[reactions[i].emoji] = reactions[i].count;
    }
    var html = '<span class="bh-reactions">';
    for (var i = 0; i < REACTION_EMOJIS.length; i++) {
      var e = REACTION_EMOJIS[i];
      var count = reactionMap[e.emoji] || 0;
      var active = myReactions.indexOf(e.emoji) !== -1;
      html += '<button class="bh-reaction' + (active ? ' bh-reaction-active' : '') +
        '" data-comment-id="' + c.id + '" data-emoji="' + e.emoji +
        '" title="' + e.label + '">' + e.emoji +
        (count > 0 ? ' <span class="bh-reaction-count">' + count + '</span>' : '') +
        '</button>';
    }
    html += '</span>';
    return html;
  }

  function renderCommentItem(c, commentMap, isReply) {
    var a = c.author || {};
    var avatarSize = isReply ? 32 : 40;
    var avatar = generateAvatar(a.avatar_seed || "?", avatarSize);
    var blogUrl = normalizeBlogUrl(a.blog_url);

    // Unified tooltip: nickname · blog (line 1), bio (line 2)
    var authorTooltip = '<div class="bh-author-tooltip">' +
      '<div class="bh-author-tooltip-name">' + escapeHtml(a.nickname || "匿名") +
        (blogUrl ? ' · <a href="' + escapeHtml(blogUrl) + '" target="_blank" rel="noopener">' + escapeHtml(blogUrl.replace(/^https?:\/\//, '')) + '</a>' : '') +
      '</div>' +
      (a.bio ? '<div class="bh-author-tooltip-bio">' + escapeHtml(a.bio) + '</div>' : '') +
    '</div>';

    var isAdmin = a.id === 0;
    var adminBadge = isAdmin ? '<span class="bh-admin-badge">Author</span>' : '';
    var authorName = blogUrl ?
      '<a class="bh-comment-author" href="' + escapeHtml(blogUrl) + '" target="_blank" rel="noopener">' + escapeHtml(a.nickname || "匿名") + '</a>' + adminBadge :
      '<span class="bh-comment-author">' + escapeHtml(a.nickname || "匿名") + '</span>' + adminBadge;

    var replyRef = "";
    if (isReply && c.parent_id) {
      var parent = commentMap[c.parent_id];
      if (parent && parent.author) {
        replyRef = '<span class="bh-reply-to">回复 @' + escapeHtml(parent.author.nickname) + '</span>';
      }
    }

    return '<div class="bh-comment-item' + (isReply ? ' bh-comment-reply' : '') + '" data-id="' + c.id + '" id="comment-' + c.id + '">' +
      '<span class="bh-comment-author-wrap">' +
        '<img class="bh-comment-avatar" src="' + avatar + '" alt=""' +
          ' style="width:' + avatarSize + 'px;height:' + avatarSize + 'px">' +
        authorTooltip +
      '</span>' +
      '<div class="bh-comment-body">' +
        '<div class="bh-comment-header">' +
          '<span class="bh-comment-author-wrap">' + authorName + authorTooltip + '</span>' +
          replyRef +
          '<span class="bh-comment-meta">' +
            '<span class="bh-comment-time">' + formatTime(c.created_at) + '</span>' +
            '<a class="bh-comment-anchor" href="#comment-' + c.id + '" title="链接到此评论">#</a>' +
          '</span>' +
        '</div>' +
        '<div class="bh-comment-content">' + renderMarkdown(c.content) + '</div>' +
        '<div class="bh-comment-actions">' +
          renderReactionButtons(c) +
          '<button class="bh-reply-btn" data-id="' + c.id + '">回复</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderCommentList(section, state, config) {
    var list = section.querySelector(".bh-comment-list");
    if (state.comments.length === 0) {
      list.innerHTML = '<div class="bh-no-comments">还没有评论，来写第一条吧</div>';
      return;
    }

    // Build map and find root ancestor for each comment
    var commentMap = {};
    var topLevel = [];
    var repliesByRoot = {};  // root_id -> [replies in order]

    for (var i = 0; i < state.comments.length; i++) {
      commentMap[state.comments[i].id] = state.comments[i];
    }

    // Find root ancestor of a comment
    function findRoot(c) {
      var cur = c;
      while (cur.parent_id && commentMap[cur.parent_id]) {
        cur = commentMap[cur.parent_id];
      }
      return cur;
    }

    for (var i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      if (!c.parent_id) {
        topLevel.push(c);
      } else {
        var root = findRoot(c);
        if (!repliesByRoot[root.id]) repliesByRoot[root.id] = [];
        repliesByRoot[root.id].push(c);
      }
    }

    // Store commentMap on state for reply button access
    state._commentMap = commentMap;

    var html = "";
    for (var i = 0; i < topLevel.length; i++) {
      var c = topLevel[i];
      html += '<div class="bh-comment-thread">';
      html += renderCommentItem(c, commentMap, false);
      var replies = repliesByRoot[c.id];
      if (replies && replies.length > 0) {
        html += '<div class="bh-comment-replies">';
        for (var j = 0; j < replies.length; j++) {
          html += renderCommentItem(replies[j], commentMap, true);
        }
        html += '</div>';
      }
      html += '</div>';
    }
    list.innerHTML = html;

    // Bind reply buttons
    var btns = list.querySelectorAll(".bh-reply-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var id = parseInt(this.getAttribute("data-id"));
        state.replyTo = commentMap[id] || null;
        showCommentForm(section, state, config);
      });
    }

    // Bind anchor links — update URL hash + flash highlight
    var anchors = list.querySelectorAll(".bh-comment-anchor");
    for (var i = 0; i < anchors.length; i++) {
      anchors[i].addEventListener("click", function (e) {
        e.preventDefault();
        var href = this.getAttribute("href");
        history.replaceState(null, "", href);
        var el = document.getElementById(href.substring(1));
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.remove("bh-comment-highlight");
          void el.offsetWidth;
          el.classList.add("bh-comment-highlight");
          setTimeout(function () { el.classList.remove("bh-comment-highlight"); }, 3000);
        }
      });
    }

    // Bind reaction buttons
    var reactionBtns = list.querySelectorAll(".bh-reaction");
    for (var i = 0; i < reactionBtns.length; i++) {
      reactionBtns[i].addEventListener("click", function () {
        var btn = this;
        var commentId = parseInt(btn.getAttribute("data-comment-id"));
        var emoji = btn.getAttribute("data-emoji");
        var isActive = btn.classList.contains("bh-reaction-active");
        var action = isActive ? "remove" : "add";

        // Optimistic UI update
        var countEl = btn.querySelector(".bh-reaction-count");
        var currentCount = countEl ? parseInt(countEl.textContent) : 0;
        var newCount = action === "add" ? currentCount + 1 : Math.max(0, currentCount - 1);
        if (newCount > 0) {
          if (countEl) {
            countEl.textContent = newCount;
          } else {
            var span = document.createElement("span");
            span.className = "bh-reaction-count";
            span.textContent = newCount;
            btn.appendChild(document.createTextNode(" "));
            btn.appendChild(span);
          }
        } else if (countEl) {
          // Remove count span and preceding text node
          if (countEl.previousSibling && countEl.previousSibling.nodeType === 3) {
            countEl.previousSibling.remove();
          }
          countEl.remove();
        }
        btn.classList.toggle("bh-reaction-active");

        // Also update state.comments for consistency
        var comment = commentMap[commentId];
        if (comment) {
          if (!comment.reactions) comment.reactions = [];
          if (!comment.my_reactions) comment.my_reactions = [];
          var found = false;
          for (var r = 0; r < comment.reactions.length; r++) {
            if (comment.reactions[r].emoji === emoji) {
              comment.reactions[r].count = newCount;
              if (newCount === 0) comment.reactions.splice(r, 1);
              found = true;
              break;
            }
          }
          if (!found && action === "add") {
            comment.reactions.push({ emoji: emoji, count: 1 });
          }
          var idx = comment.my_reactions.indexOf(emoji);
          if (action === "add" && idx === -1) comment.my_reactions.push(emoji);
          if (action === "remove" && idx !== -1) comment.my_reactions.splice(idx, 1);
        }

        // Send to API
        getFingerprint().then(function (fp) {
          apiReact(config, commentId, emoji, fp, action);
        });
      });
    }
  }

  function renderCommentForm(section, state, config, slug) {
    slug = slug || getCurrentSlug();
    var form = section.querySelector(".bh-comment-form");
    var me = state.me;
    var token = getCommenterToken();

    var formHeader = '';
    var identityFields = '';

    if (me && token) {
      // Logged-in: show user badge with unified tooltip (same as comment authors)
      var avatar = generateAvatar(me.nickname || '?', 24);
      var meBlogUrl = normalizeBlogUrl(me.blog_url);
      formHeader =
        '<div class="bh-form-header">' +
          '<div class="bh-comment-form-title">写评论</div>' +
          '<div class="bh-user-badge">' +
            '<img class="bh-user-badge-avatar" src="' + avatar + '" alt="">' +
            '<span class="bh-user-badge-name">' + escapeHtml(me.nickname) + '</span>' +
            '<span class="bh-user-badge-edit">编辑</span>' +
            '<div class="bh-author-tooltip">' +
              '<div class="bh-author-tooltip-name">' + escapeHtml(me.nickname) +
                (meBlogUrl ? ' · <a href="' + escapeHtml(meBlogUrl) + '" target="_blank" rel="noopener">' + escapeHtml(meBlogUrl.replace(/^https?:\/\//, '')) + '</a>' : '') +
              '</div>' +
              (me.bio ? '<div class="bh-author-tooltip-bio">' + escapeHtml(me.bio) + '</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      identityFields = '<input type="hidden" name="has_token" value="1">';
    } else {
      // First-time: all fields visible, email first (auto-fill on blur)
      formHeader = '<div class="bh-comment-form-title">写评论</div>';
      identityFields =
        '<div class="bh-form-row"><label>邮箱 <span class="bh-required">*</span> <span class="bh-hint">唯一身份标识，不会公开</span></label><input type="email" name="email" placeholder="your@email.com" required></div>' +
        '<div class="bh-form-identity" style="margin-top:12px">' +
          '<div class="bh-form-row"><label>昵称 <span class="bh-required">*</span> <span class="bh-label-actions"><a href="#" class="bh-action-random" data-target="nickname">随机来个</a><span class="bh-action-sep">|</span><a href="#" class="bh-action-clear" data-target="nickname">清空</a></span></label><input type="text" name="nickname" placeholder="你怎么称呼？"></div>' +
          '<div class="bh-form-row"><label>博客地址 <span class="bh-optional">可选</span></label><input type="text" name="blog_url" placeholder="example.com"></div>' +
        '</div>' +
        '<div class="bh-form-row" style="margin-top:12px"><label>个性签名 <span class="bh-optional">可选</span> <span class="bh-label-actions"><a href="#" class="bh-action-random" data-target="bio">随机来个</a><span class="bh-action-sep">|</span><a href="#" class="bh-action-clear" data-target="bio">清空</a></span></label><input type="text" name="bio" placeholder="一句话介绍自己"></div>';
    }

    var replyPreview = "";
    if (state.replyTo) {
      var rt = state.replyTo;
      replyPreview = '<div class="bh-reply-preview"><span>回复 @' +
        escapeHtml(rt.author ? rt.author.nickname : "?") + ': ' +
        escapeHtml((rt.content || "").substring(0, 60)) +
        '</span><button class="bh-reply-cancel" title="取消回复">✕</button></div>';
    }

    form.innerHTML =
      formHeader +
      identityFields +
      replyPreview +
      '<div class="bh-form-row">' +
        '<div class="bh-editor-tabs">' +
          '<button type="button" class="bh-editor-tab bh-tab-active" data-tab="write">编写</button>' +
          '<button type="button" class="bh-editor-tab" data-tab="preview">预览</button>' +
        '</div>' +
        '<label style="font-size:13px;color:#999;margin-bottom:4px;display:block">内容 <span class="bh-required">*</span></label>' +
        '<textarea name="content" placeholder="留下你的想法，让更多人看到不一样的视角 ✨&#10;Markdown 基础语法随意用 :)" maxlength="1024" required></textarea>' +
        '<div class="bh-md-preview" style="display:none"></div>' +
      '</div>' +
      '<div style="text-align:right;margin-top:12px"><button type="button" class="bh-submit-btn">提交评论</button></div>' +
      '<div class="bh-form-msg"></div>' +
      '<div class="bh-form-overlay" style="display:none"><div class="bh-form-overlay-inner"><span class="bh-overlay-spinner"></span>loading...</div></div>' +
      '<div style="position:absolute;left:-9999px"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>';

    // Profile panel on badge click
    var badge = form.querySelector(".bh-user-badge");
    if (badge && me) {
      badge.addEventListener("click", function (e) {
        e.stopPropagation();
        showProfilePanel(state, config, section);
      });
    }

    // Cancel reply
    var cancelBtn = form.querySelector(".bh-reply-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        state.replyTo = null;
        hideCommentForm(section);
      });
    }

    // Email onBlur: lookup existing user or auto-fill nickname from email
    var emailInput = form.querySelector('input[name="email"]');
    if (emailInput) {
      emailInput.addEventListener("blur", function () {
        var email = this.value.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
        var nn = form.querySelector('input[name="nickname"]');
        var bl = form.querySelector('input[name="blog_url"]');
        var bio = form.querySelector('input[name="bio"]');
        apiLookupCommenter(config, email).then(function (data) {
          if (data) {
            // Existing user: fill all fields
            if (nn) nn.value = data.nickname || "";
            if (bl && !bl.value) bl.value = data.blog_url || "";
            if (bio && !bio.value) bio.value = data.bio || "";
            var msg = form.querySelector(".bh-form-msg");
            if (msg) {
              msg.className = "bh-form-msg bh-success";
              msg.textContent = "欢迎回来，" + (data.nickname || "");
            }
          }
        });
      });
    }

    // Random / Clear actions
    var RANDOM_NICKNAMES = [
      "路过的猫", "匿名侠", "吃瓜群众", "深夜读者", "代码诗人", "摸鱼达人", "赛博游民", "键盘侠", "月球访客", "时间旅人",
      "咖啡续命者", "星际漫游", "像素猎人", "量子纠缠", "午夜编译", "佛系青年", "电子幽灵", "云端漫步", "Bug猎手", "数据巫师",
      "暗号是猫", "脑洞大开", "像风一样", "无名之辈", "夜猫子", "追光者", "半糖主义", "咸鱼翻身", "平行世界", "代码民工",
      "奶茶星人", "逻辑怪", "退堂鼓选手", "宇宙尘埃", "梦境建筑师", "信号满格", "ctrl+z人生", "默认头像", "随机路人", "404少年",
      "异步等待", "光年之外", "回调地狱", "堆栈溢出", "空指针", "递归少女", "浮点误差", "未定义行为", "野生程序员", "编译通过",
      "今天不加班", "自由变量", "薛定谔的猫", "二进制诗人", "开源信徒"
    ];
    var RANDOM_BIOS = [
      "人生苦短，及时行乐", "在代码与咖啡之间徘徊", "保持好奇心", "生活不止眼前的 Bug", "半夜还在刷博客的人",
      "路过，留个脚印", "今天也要开心鸭", "佛系冲浪选手", "永远好奇，永远热泪盈眶", "一个认真摸鱼的人",
      "代码是写给人看的", "在自己的时区里努力", "生活就是不断重构", "把日子过成诗", "灵感来自凌晨三点",
      "世界很大，先写完这行代码", "用代码丈量世界", "技术宅拯救世界", "不是在调试就是在写Bug", "永远年轻永远热泪盈眶",
      "对世界充满善意", "做有趣的事，交有趣的人", "在互联网上留下痕迹", "今天的我比昨天厉害一点点", "正在加载人生...",
      "Hello World 说了好多年", "此刻即永恒", "万物皆可编程", "在信息洪流中冲浪", "一枚安静的开发者",
      "从入门到放弃再到入门", "写字的时候最平静", "读书喝茶写代码", "生活需要仪式感", "认真生活，快乐coding",
      "用0和1构建梦想", "debug是一种生活态度", "保持学习，保持谦逊", "简单生活，深度思考", "做自己喜欢的事",
      "在这里记录成长", "看见世界的另一面", "温柔且有力量", "享受每一个灵光乍现", "明天的我一定更强",
      "喜欢安静也喜欢热闹", "一杯咖啡一行代码", "向着光走", "慢慢来比较快", "不完美但真实",
      "永远对新事物好奇", "脑子里全是奇怪想法", "偶尔写字偶尔发呆", "人间观察员", "数字游民在路上"
    ];
    var randomBags = {};
    function pickRandom(pool, key) {
      if (!randomBags[key] || randomBags[key].length === 0) {
        randomBags[key] = pool.slice();
        for (var i = randomBags[key].length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = randomBags[key][i]; randomBags[key][i] = randomBags[key][j]; randomBags[key][j] = tmp;
        }
      }
      return randomBags[key].pop();
    }
    var randomLinks = form.querySelectorAll(".bh-action-random");
    for (var ri = 0; ri < randomLinks.length; ri++) {
      randomLinks[ri].addEventListener("click", function (e) {
        e.preventDefault();
        var target = this.getAttribute("data-target");
        var input = form.querySelector('input[name="' + target + '"]');
        if (!input) return;
        var pool = target === "nickname" ? RANDOM_NICKNAMES : RANDOM_BIOS;
        input.value = pickRandom(pool, target);
      });
    }
    var clearLinks = form.querySelectorAll(".bh-action-clear");
    for (var ci = 0; ci < clearLinks.length; ci++) {
      clearLinks[ci].addEventListener("click", function (e) {
        e.preventDefault();
        var target = this.getAttribute("data-target");
        var input = form.querySelector('input[name="' + target + '"]');
        if (input) input.value = "";
      });
    }

    // Write / Preview tab switching
    var tabs = form.querySelectorAll(".bh-editor-tab");
    var textarea = form.querySelector('textarea[name="content"]');
    var preview = form.querySelector(".bh-md-preview");
    for (var ti = 0; ti < tabs.length; ti++) {
      tabs[ti].addEventListener("click", function () {
        var tab = this.getAttribute("data-tab");
        for (var tj = 0; tj < tabs.length; tj++) tabs[tj].classList.remove("bh-tab-active");
        this.classList.add("bh-tab-active");
        if (tab === "preview") {
          textarea.style.display = "none";
          preview.style.display = "block";
          var raw = textarea.value.trim();
          if (!raw) {
            preview.innerHTML = '<span style="color:#999">没有内容可预览</span>';
          } else {
            preview.innerHTML = renderMarkdown(raw);
          }
        } else {
          textarea.style.display = "";
          preview.style.display = "none";
          textarea.focus();
        }
      });
    }

    // Submit handler
    var submitBtn = form.querySelector(".bh-submit-btn");
    submitBtn.addEventListener("click", function () {
      var contentEl = form.querySelector('textarea[name="content"]');
      var content = contentEl.value.trim();
      var msgEl = form.querySelector(".bh-form-msg");

      if (!content) {
        msgEl.className = "bh-form-msg bh-error";
        msgEl.textContent = "请输入评论内容";
        return;
      }

      // Content length limit (1024 chars)
      if (content.length > 1024) {
        msgEl.className = "bh-form-msg bh-error";
        msgEl.textContent = "评论内容不能超过 1024 个字符（当前 " + content.length + " 个）";
        return;
      }

      // Honeypot check
      var honeypot = form.querySelector('input[name="website"]');
      if (honeypot && honeypot.value) return;

      var email = (form.querySelector('input[name="email"]') || {}).value || "";
      var nickname = (form.querySelector('input[name="nickname"]') || {}).value || "";
      var blogUrlEl = form.querySelector('input[name="blog_url"]');
      var blogUrl = blogUrlEl ? blogUrlEl.value.trim() : "";

      if (!token) {
        // Validate email
        if (!email.trim()) {
          msgEl.className = "bh-form-msg bh-error";
          msgEl.textContent = "请填写邮箱";
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          msgEl.className = "bh-form-msg bh-error";
          msgEl.textContent = "邮箱格式不正确";
          return;
        }
        // Validate nickname
        if (!nickname.trim()) {
          msgEl.className = "bh-form-msg bh-error";
          msgEl.textContent = "请填写昵称";
          return;
        }
        // Validate blog URL format (if provided)
        if (blogUrl) {
          var urlToCheck = normalizeBlogUrl(blogUrl);
          try { new URL(urlToCheck); } catch (e) {
            msgEl.className = "bh-form-msg bh-error";
            msgEl.textContent = "博客地址格式不正确";
            return;
          }
        }
      }

      // Normalize blog_url before submit
      if (blogUrlEl && blogUrl) {
        blogUrl = normalizeBlogUrl(blogUrl);
      }

      // Show loading overlay
      var overlay = form.querySelector(".bh-form-overlay");
      overlay.style.display = "";
      submitBtn.disabled = true;
      msgEl.className = "bh-form-msg";
      msgEl.textContent = "";

      apiGetChallenge(config).then(function (challengeData) {
        if (!challengeData) throw new Error("无法获取验证信息");
        return solveChallenge(challengeData.challenge).then(function (answer) {
          return { challenge: challengeData.challenge, answer: answer };
        });
      }).then(function (proof) {
        return apiPostComment(config, {
          site_id: config.siteId,
          page_slug: slug,
          email: email.trim(),
          nickname: nickname.trim(),
          blog_url: blogUrl,
          bio: (form.querySelector('input[name="bio"]') || {}).value || "",
          content: content,
          parent_id: state.replyTo ? state.replyTo.id : null,
          fingerprint: _fingerprintCache || "",
          challenge: proof.challenge,
          answer: proof.answer,
        });
      }).then(function (resp) {
        overlay.style.display = "none";
        submitBtn.disabled = false;

        if (resp.ok) {
          // Save token
          if (resp.data.token) {
            setCommenterToken(resp.data.token);
          }
          if (resp.data.me) {
            state.me = resp.data.me;
          }
          // Add to list (only if approved)
          var newComment = resp.data.comment;
          if (newComment && newComment.status === "approved") {
            state.comments.push(newComment);
          }
          state.replyTo = null;
          renderCommentList(section, state, config);
          hideCommentForm(section);
          // Show pending notice
          if (newComment && newComment.status === "pending") {
            var notice = document.createElement("div");
            notice.className = "bh-pending-notice";
            notice.textContent = "评论已提交，等待审核后展示";
            var list = section.querySelector(".bh-comment-list");
            if (list) list.insertBefore(notice, list.firstChild);
            setTimeout(function() { if (notice.parentNode) notice.parentNode.removeChild(notice); }, 5000);
          }
        } else {
          msgEl.className = "bh-form-msg bh-error";
          msgEl.textContent = resp.error ? resp.error.message : "提交失败";
        }
      }).catch(function (err) {
        overlay.style.display = "none";
        submitBtn.disabled = false;
        msgEl.className = "bh-form-msg bh-error";
        msgEl.textContent = err.message || "提交失败";
      });
    });
  }

  // ============================================================
  // 6a-3. Profile Panel
  // ============================================================

  function apiUpdateProfile(config, data) {
    var base = commentApiBase(config);
    return fetch(base + "/commenter/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(data),
    }).then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: { message: "Network error" } }; });
  }

  function showProfilePanel(state, config, section) {
    var me = state.me;
    if (!me) return;

    var panel = document.createElement("div");
    panel.className = "bh-profile-panel";
    panel.innerHTML =
      '<div class="bh-profile-card">' +
        '<h3>个人资料</h3>' +
        '<div class="bh-profile-field"><label>昵称</label><input type="text" name="nickname" value="' + escapeHtml(me.nickname || '') + '" disabled></div>' +
        '<div class="bh-profile-field"><label>邮箱 <span style="color:#bbb;font-size:11px">仅自己可见，唯一身份标识</span></label><input type="email" name="email" value="' + escapeHtml(me.email || '') + '" disabled></div>' +
        '<div class="bh-profile-field"><label>博客地址</label><input type="text" name="blog_url" value="' + escapeHtml(me.blog_url || '') + '" placeholder="example.com"></div>' +
        '<div class="bh-profile-field"><label>个性签名</label><input type="text" name="bio" value="' + escapeHtml(me.bio || '') + '" placeholder="一句话介绍自己"></div>' +
        '<div class="bh-profile-actions">' +
          '<button type="button" class="bh-profile-cancel">取消</button>' +
          '<button type="button" class="bh-profile-save">保存</button>' +
        '</div>' +
        '<div class="bh-profile-msg"></div>' +
      '</div>';

    document.body.appendChild(panel);

    // Close on backdrop click
    panel.addEventListener("click", function (e) {
      if (e.target === panel) panel.remove();
    });

    // Cancel button
    panel.querySelector(".bh-profile-cancel").addEventListener("click", function () {
      panel.remove();
    });

    // Save button
    panel.querySelector(".bh-profile-save").addEventListener("click", function () {
      var card = panel.querySelector(".bh-profile-card");
      var nickname = card.querySelector('input[name="nickname"]').value.trim();
      var blogUrl = card.querySelector('input[name="blog_url"]').value.trim();
      var bio = card.querySelector('input[name="bio"]').value.trim();
      var msg = panel.querySelector(".bh-profile-msg");

      if (blogUrl) blogUrl = normalizeBlogUrl(blogUrl);

      apiUpdateProfile(config, {
        nickname: nickname,
        blog_url: blogUrl,
        bio: bio,
      }).then(function (resp) {
        if (resp.ok) {
          // Update local state
          state.me.nickname = nickname;
          state.me.blog_url = blogUrl;
          state.me.bio = bio;
          msg.style.color = "#28a745";
          msg.textContent = "已保存";
          setTimeout(function () {
            panel.remove();
            // Re-render form to reflect new name
            if (section) renderCommentForm(section, state, config);
          }, 800);
        } else {
          msg.style.color = "#c00";
          msg.textContent = resp.error ? resp.error.message : "保存失败";
        }
      });
    });
  }

  // ============================================================
  // 6b. Sidebar Comment Widgets
  // ============================================================

  function sidebarCommentLink(c) {
    var author = c.author ? c.author.nickname : "匿名";
    var text = (c.content || "").replace(/\n/g, " ").substring(0, 50);
    var href = escapeHtml(c.page_slug) + "#comment-" + c.id;
    var display = author + "回复: " + text;

    // Right side: time / emoji
    var metaParts = [];
    var time = formatTime(c.created_at, true);
    if (time) metaParts.push(time);
    var reactions = c.reactions || [];
    for (var i = 0; i < reactions.length; i++) {
      metaParts.push(reactions[i].emoji + reactions[i].count);
    }
    var meta = metaParts.length > 0 ? '<span class="ba-sc-meta">' + metaParts.join(" ") + '</span>' : '';

    return '<span class="ba-sc-content" data-href="' + href + '" title="' + escapeHtml(author + ': ' + (c.content || '')) + '">' +
      escapeHtml(display) + '</span>' + meta;
  }

  function renderSidebarComments(config, comments, mountId, title) {
    if (!comments || comments.length === 0) return;
    var mount = document.querySelector(mountId) ||
                document.querySelector(config.selectors.sidebarMount);
    if (!mount) return;

    var html = '<div class="sidebar-section ba-sidebar-comments">';
    html += '<div class="sidebar-title">' + escapeHtml(title) + '</div>';
    for (var i = 0; i < comments.length; i++) {
      html += '<div class="ba-sc-item">' + sidebarCommentLink(comments[i]) + '</div>';
    }
    html += '</div>';
    var el = createElementFromHTML(html);
    bindSidebarCommentClicks(el);
    mount.appendChild(el);
  }

  function bindSidebarCommentClicks(container) {
    var items = container.querySelectorAll(".ba-sc-content[data-href]");
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener("click", function () {
        window.location.href = this.getAttribute("data-href");
      });
    }
  }

  // ============================================================
  // 7. Main / Init
  // ============================================================

  function init() {
    var config = loadConfig();

    // Auto-detect apiBase from current domain if not configured
    if (!config.apiBase) {
      config.apiBase =
        window.location.protocol + "//" + window.location.host + "/api/v1/analytics";
    }

    // Auto-detect siteId from current hostname if not configured
    if (!config.siteId) {
      config.siteId = window.location.hostname;
    }

    injectStyles();

    var pageType = detectPageType(config);
    var promises = [];

    // Post page: report PV + show stats + comment count
    if (pageType === "post" && config.features.reportPV) {
      var slug = getCurrentSlug();
      var title = getCurrentTitle();

      var reportPromise = getFingerprint().then(function (fp) {
        return apiReport(config, slug, title, fp);
      });

      if (config.features.showPostStats) {
        reportPromise = reportPromise.then(function (data) {
          if (data) {
            renderPostStats(config, data.pv, data.uv);
          }
          // Append comment count + heart count to post stats
          return Promise.all([
            apiCommentCounts(config, [slug]),
            apiPageReactions(config, slug, null),
          ]).then(function (results) {
            var counts = results[0];
            var pageReactions = results[1];
            var statsEl = document.querySelector(".ba-stats");
            if (!statsEl) return;
            if (counts) {
              for (var i = 0; i < counts.length; i++) {
                if (counts[i].page_slug === slug) {
                  statsEl.innerHTML += '<span class="ba-separator">' + config.separator + '</span>评论 ' + counts[i].count;
                  break;
                }
              }
            }
            if (pageReactions && pageReactions.reactions) {
              var heartCount = 0;
              for (var i = 0; i < pageReactions.reactions.length; i++) {
                if (pageReactions.reactions[i].emoji === "\u2764\uFE0F") {
                  heartCount = pageReactions.reactions[i].count;
                }
              }
              if (heartCount > 0) {
                statsEl.innerHTML += '<span class="ba-separator">' + config.separator + '</span>\u2764\uFE0F ' + heartCount;
              }
            }
          });
        });
      }
      promises.push(reportPromise);
    }

    // List page: insert placeholders first, then batch fetch PV
    if (pageType === "list" && config.features.showListPV) {
      var items = document.querySelectorAll(config.selectors.listItems);
      var slugs = [];

      // Step 1: insert invisible placeholders to reserve space
      for (var i = 0; i < items.length; i++) {
        var link = items[i].querySelector(config.selectors.listItemLink);
        if (link && link.href) {
          try {
            slugs.push(normalizeSlug(new URL(link.href).pathname));
          } catch (e) {
            continue;
          }
          var target =
            items[i].querySelector(".post-meta") ||
            items[i].querySelector("time") ||
            items[i].querySelector("h3, h2") ||
            link.parentNode;
          if (target && !items[i].querySelector(".ba-pv")) {
            var ph = document.createElement("span");
            ph.className = "ba-pv";
            ph.textContent = "\u00a0"; // &nbsp; to hold line height
            target.appendChild(ph);
          }
        }
      }

      // Step 2: fetch data and populate placeholders
      if (slugs.length > 0) {
        promises.push(
          apiBatchStats(config, slugs).then(function (statsMap) {
            renderListPV(config, statsMap);
          })
        );
        // Also fetch comment counts for list items
        promises.push(
          apiCommentCounts(config, slugs).then(function (counts) {
            if (!counts) return;
            var countMap = {};
            for (var i = 0; i < counts.length; i++) {
              countMap[counts[i].page_slug] = counts[i].count;
            }
            var items = document.querySelectorAll(config.selectors.listItems);
            for (var i = 0; i < items.length; i++) {
              var link = items[i].querySelector(config.selectors.listItemLink);
              if (!link || !link.href) continue;
              try {
                var itemSlug = normalizeSlug(new URL(link.href).pathname);
                var cc = countMap[itemSlug];
                if (cc !== undefined && cc > 0) {
                  var pvEl = items[i].querySelector(".ba-pv");
                  if (pvEl && pvEl.classList.contains("ba-pv-ready")) {
                    pvEl.textContent += " | 评论 " + cc;
                  }
                }
              } catch (e) {}
            }
          })
        );
      }
    }

    // Popular articles for sidebar
    if (config.features.showPopular) {
      promises.push(
        apiPopular(
          config,
          config.features.popularLimit,
          config.features.popularPeriod
        ).then(function (articles) {
          renderPopular(config, articles);
        })
      );
    }

    // Active visitors
    if (config.features.showActive) {
      promises.push(
        apiActive(config, config.features.activeMinutes).then(function (data) {
          renderActive(config, data);
        })
      );
    }

    // Site trend sparkline
    if (config.features.showTrend) {
      promises.push(
        apiTrend(config, config.features.trendDays).then(function (data) {
          renderTrend(config, data);
        })
      );
    }

    // Top referrers
    if (config.features.showReferrers) {
      promises.push(
        apiReferrers(config, config.features.referrersDays, config.features.referrersLimit).then(function (data) {
          renderReferrers(config, data);
        })
      );
    }

    // Page reactions (always available on post pages, independent of comment mode)
    if (pageType === "post") {
      var commentSlug = getCurrentSlug();
      promises.push(Promise.resolve().then(function () {
        renderPageReactions(config, commentSlug);
      }));

      // Comment section: true = render, "auto" = detect from backend, false = skip
      if (config.features.showComments === true) {
        promises.push(Promise.resolve().then(function () {
          renderCommentSection(config, commentSlug);
        }));
      } else if (config.features.showComments === "auto") {
        promises.push(
          fetch(commentApiBase(config) + "/comments/config", { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.ok && d.data && d.data.enabled) {
                renderCommentSection(config, commentSlug);
              }
            })
            .catch(function () { /* comments not available, silent */ })
        );
      }
    }

    // Sidebar: recent comments + hot comments (only if comments enabled)
    // Sidebar: recent + hot comments (only if comments not explicitly disabled)
    if (config.features.showComments !== false) {
      promises.push(
        fetch(commentApiBase(config) + "/comments/config", { credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d.ok || !d.data || !d.data.enabled) return;
            return Promise.all([
              apiRecentComments(config, 5).then(function (data) { renderSidebarComments(config, data, "#bh-recent-comments-mount", "Recent Comments"); }),
              apiHotComments(config, 5).then(function (data) { renderSidebarComments(config, data, "#bh-hot-comments-mount", "Hot Comments"); }),
            ]);
          })
          .catch(function () { /* silent */ })
      );
    }

    // Execute all in parallel
    Promise.all(promises).catch(function () {
      // Swallow all errors — the blog must always work
    });
  }

  // Run on DOMContentLoaded or immediately if already loaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
