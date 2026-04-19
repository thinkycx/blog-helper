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
      showComments: false,
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
    if (document.getElementById("ba-styles")) return;
    var style = document.createElement("style");
    style.id = "ba-styles";
    style.textContent = [
      // List page: PV below date, placeholder reserves space, fade in when ready
      "@keyframes ba-fadein { from { opacity: 0; } to { opacity: 1; } }",
      ".ba-pv { display: block; font-size: 12px; white-space: nowrap; min-height: 1.4em; opacity: 0; }",
      ".ba-pv-ready { color: #999; opacity: 1; animation: ba-fadein 0.3s ease; }",
      // Post page: inline PV/UV, right side
      ".ba-stats { color: #586069; font-size: 13px; float: right; white-space: nowrap; line-height: inherit; }",
      ".ba-stats .ba-separator { margin: 0 4px; color: #d1d5da; }",
      // Popular sidebar — matches TOC: sidebar-section + sidebar-title structure
      ".ba-popular ul { list-style: none; padding-left: 0; margin: 0; }",
      ".ba-popular li { margin-bottom: 4px; display: flex; justify-content: space-between; align-items: baseline; }",
      ".ba-popular li a { font-size: 13px; color: #586069; padding: 2px 4px; border-radius: 3px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; transition: all 0.2s; }",
      ".ba-popular li a:hover { color: #0366d6; background-color: #f1f8ff; text-decoration: none; }",
      ".ba-popular .ba-count { color: #586069; font-size: 12px; flex-shrink: 0; padding-left: 6px; }",
      // Active visitors badge
      ".ba-active { font-size: 13px; color: #586069; margin-bottom: 12px; }",
      ".ba-active-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #28a745; margin-right: 4px; animation: ba-pulse 2s infinite; }",
      "@keyframes ba-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }",
      ".ba-active-count { font-weight: 600; color: #24292e; }",
      // Trend sparkline
      ".ba-trend { margin-bottom: 12px; }",
      ".ba-trend-chart { display: flex; align-items: flex-end; gap: 1px; height: 40px; }",
      ".ba-trend-bar { flex: 1; min-height: 2px; background: #0366d6; border-radius: 1px 1px 0 0; opacity: 0.7; transition: opacity 0.2s; }",
      ".ba-trend-bar:hover { opacity: 1; }",
      ".ba-trend-summary { font-size: 12px; color: #586069; margin-top: 4px; }",
      // Referrers list (reuses popular styling)
      ".ba-referrers ul { list-style: none; padding-left: 0; margin: 0; }",
      ".ba-referrers li { margin-bottom: 4px; display: flex; justify-content: space-between; align-items: baseline; }",
      ".ba-referrers li span:first-child { font-size: 13px; color: #586069; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }",
      ".ba-referrers .ba-count { color: #586069; font-size: 12px; flex-shrink: 0; padding-left: 6px; }",
    ].join("\n");
    document.head.appendChild(style);
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

  // Format time — relative for recent, exact for older
  function formatTime(dateStr) {
    // Handle both "2024-01-15 14:30:00" and "2024-01-15T14:30:00Z"
    var s = dateStr.indexOf('T') === -1 ? dateStr.replace(' ', 'T') + 'Z' : dateStr;
    var date = new Date(s);
    var now = new Date();
    var diff = Math.floor((now - date) / 1000);
    if (diff < 60) return diff + " 秒前";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    return y + '-' + m + '-' + d + ' ' + hh + ':' + mm;
  }

  // Lightweight Markdown renderer (safe: escapeHtml first, then apply formatting)
  // --- Markdown rendering via marked.js (lazy-loaded from CDN) ---

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
    // Use marked.js if loaded, otherwise basic fallback
    if (window.marked && window.marked.parse) {
      var html = window.marked.parse(raw);
      return sanitizeHTML(html);
    }
    // Fallback: basic rendering (already escapes HTML internally)
    return renderMarkdownFallback(raw);
  }

  function renderMarkdownFallback(raw) {
    var text = escapeHtml(raw);
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre class="bh-md-pre"><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });
    text = text.replace(/`([^`\n]+)`/g, '<code class="bh-md-code">$1</code>');
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="bh-md-img" src="$2" alt="$1">');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    var lines = text.split('\n');
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (line.indexOf('<pre class="bh-md-pre">') !== -1) {
        var preBlock = line;
        while (i < lines.length - 1 && lines[i].indexOf('</pre>') === -1) { i++; preBlock += '\n' + lines[i]; }
        out.push(preBlock); i++; continue;
      }
      if (/^&gt;\s?(.*)/.test(line)) {
        var bqLines = [];
        while (i < lines.length && /^&gt;\s?(.*)/.test(lines[i])) { bqLines.push(lines[i].replace(/^&gt;\s?/, '')); i++; }
        out.push('<blockquote class="bh-md-bq">' + bqLines.join('<br>') + '</blockquote>'); continue;
      }
      if (/^[-*]\s+(.+)/.test(line)) {
        var items = [];
        while (i < lines.length && /^[-*]\s+(.+)/.test(lines[i])) { items.push('<li>' + lines[i].replace(/^[-*]\s+/, '') + '</li>'); i++; }
        out.push('<ul class="bh-md-ul">' + items.join('') + '</ul>'); continue;
      }
      if (/^\d+\.\s+(.+)/.test(line)) {
        var items = [];
        while (i < lines.length && /^\d+\.\s+(.+)/.test(lines[i])) { items.push('<li>' + lines[i].replace(/^\d+\.\s+/, '') + '</li>'); i++; }
        out.push('<ol class="bh-md-ol">' + items.join('') + '</ol>'); continue;
      }
      if (line.trim() === '') { out.push(''); i++; continue; }
      out.push(line); i++;
    }
    var result = [], paragraph = [];
    for (var j = 0; j < out.length; j++) {
      if (out[j] === '') { if (paragraph.length > 0) { result.push(paragraph.join('<br>')); paragraph = []; } }
      else { paragraph.push(out[j]); }
    }
    if (paragraph.length > 0) result.push(paragraph.join('<br>'));
    return result.join('<br><br>');
  }

  function injectCommentStyles() {
    if (document.getElementById("bh-comment-styles")) return;
    var style = document.createElement("style");
    style.id = "bh-comment-styles";
    style.textContent = [
      ".bh-comments { margin-top: 40px; border-top: 1px solid #ddd; padding-top: 24px; font-family: inherit; color: #333; }",
      ".bh-comments-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid #ddd; color: #333; }",
      ".bh-comment-list { padding: 0; margin: 0 0 24px; }",
      ".bh-comment-thread { border-bottom: 1px solid #eee; }",
      ".bh-comment-thread:last-child { border-bottom: none; }",
      ".bh-comment-item { display: flex; gap: 10px; padding: 10px 0; transition: background 0.5s; }",
      ".bh-comment-highlight { background: #fff3cd; border-radius: 6px; box-shadow: 0 0 0 2px #ffe69c; }",
      ".bh-comment-replies { margin-left: 50px; border-left: 2px solid #eee; padding-left: 12px; }",
      ".bh-comment-replies .bh-comment-item { padding: 8px 0; }",
      ".bh-reply-to { font-size: 12px; color: #666; }",
      ".bh-comment-avatar { width: 40px; height: 40px; border-radius: 5px; flex-shrink: 0; }",
      ".bh-comment-body { flex: 1; min-width: 0; }",
      ".bh-comment-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }",
      ".bh-comment-author { font-weight: 600; font-size: 14px; color: #555; text-decoration: none; cursor: default; }",
      "a.bh-comment-author { cursor: pointer; }",
      "a.bh-comment-author:hover { color: #555; }",
      ".bh-comment-meta { margin-left: auto; display: flex; align-items: baseline; gap: 8px; flex-shrink: 0; }",
      ".bh-comment-time { font-size: 12px; color: #999; white-space: nowrap; }",
      ".bh-comment-anchor { font-size: 12px; color: #ddd; text-decoration: none; }",
      ".bh-comment-anchor:hover { color: #999; }",
      ".bh-comment-content { font-size: 14px; line-height: 1.5; color: #333; word-break: break-word; }",
      ".bh-comment-content p { margin: 0 0 4px; }",
      ".bh-comment-content p:last-child { margin-bottom: 0; }",
      ".bh-comment-actions { margin-top: 4px; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }",
      ".bh-reactions { display: flex; gap: 2px; margin-left: auto; }",
      ".bh-reaction { background: none; border: 1px solid transparent; font-size: 12px; cursor: pointer; padding: 1px 5px; border-radius: 10px; display: inline-flex; align-items: center; gap: 2px; transition: all 0.15s; filter: grayscale(1); opacity: 0.45; }",
      ".bh-reaction:hover { filter: grayscale(0); opacity: 1; border-color: #e8e8e8; background: #fafafa; }",
      ".bh-reaction-active { filter: grayscale(0); opacity: 1; border-color: #e0e0e0; background: #f5f5f5; }",
      ".bh-reaction .bh-reaction-count { font-size: 11px; color: #999; }",
      ".bh-reaction-active .bh-reaction-count { color: #666; }",
      ".bh-comment-actions .bh-reply-btn { background: none; border: none; color: #999; font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 3px; }",
      ".bh-comment-actions .bh-reply-btn:hover { color: #333; background: #f5f5f5; }",
      ".bh-comment-form-trigger { text-align: center; padding: 8px 0; }",
      ".bh-write-comment-btn { background: none; border: 1px solid #ddd; color: #555; padding: 6px 20px; border-radius: 5px; font-size: 14px; cursor: pointer; transition: all 0.2s; }",
      ".bh-write-comment-btn:hover { border-color: #999; color: #333; }",
      ".bh-comment-form { background: #fff; border: 1px solid #ddd; border-radius: 5px; padding: 20px; }",
      ".bh-comment-form-title { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: #333; margin: 0; }",
      ".bh-form-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }",
      ".bh-form-header .bh-comment-form-title { margin-bottom: 0; }",
      /* User badge */
      ".bh-user-badge { position: relative; display: flex; align-items: center; gap: 6px; cursor: default; }",
      ".bh-user-badge-avatar { width: 24px; height: 24px; border-radius: 4px; }",
      ".bh-user-badge-name { font-size: 13px; color: #555; }",
      ".bh-user-tooltip { display: none; position: absolute; top: 100%; right: 0; margin-top: 6px; background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 10px 14px; min-width: 180px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); z-index: 10; font-size: 13px; }",
      ".bh-user-badge:hover .bh-user-tooltip { display: block; }",
      ".bh-user-tooltip-row { margin-bottom: 4px; color: #333; }",
      ".bh-user-tooltip-row:last-child { margin-bottom: 0; }",
      ".bh-user-tooltip-bio { color: #999; }",
      ".bh-user-tooltip-row a { color: #555; text-decoration: none; word-break: break-all; }",
      ".bh-user-tooltip-row a:hover { text-decoration: underline; }",
      ".bh-form-row { margin-bottom: 12px; }",
      ".bh-form-row label { display: block; font-size: 13px; color: #999; margin-bottom: 4px; }",
      ".bh-required { color: #c00; }",
      ".bh-optional { color: #bbb; font-size: 11px; }",
      ".bh-hint { color: #bbb; font-size: 11px; }",
      ".bh-form-row input, .bh-form-row textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 5px; font-size: 14px; font-family: inherit; box-sizing: border-box; background: #fff; transition: border-color 0.2s; }",
      ".bh-form-row input:focus, .bh-form-row textarea:focus { outline: none; border-color: #333; box-shadow: 0 0 0 2px rgba(0,0,0,0.08); }",
      ".bh-form-row textarea { min-height: 100px; resize: vertical; }",
      ".bh-form-identity { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }",
      ".bh-form-identity .bh-form-row { margin-bottom: 0; }",
      ".bh-reply-preview { font-size: 13px; color: #999; background: #fff; padding: 8px 12px; border-radius: 5px; border-left: 3px solid #999; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }",
      ".bh-reply-cancel { background: none; border: none; color: #999; cursor: pointer; font-size: 12px; }",
      ".bh-reply-cancel:hover { color: #333; }",
      ".bh-submit-btn { display: inline-flex; align-items: center; gap: 8px; background: #333; color: #fff; border: none; padding: 8px 20px; border-radius: 5px; font-size: 14px; cursor: pointer; transition: background 0.2s; }",
      ".bh-submit-btn:hover { background: #555; }",
      ".bh-submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }",
      ".bh-submit-btn .bh-spinner { display: none; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: bh-spin 0.6s linear infinite; }",
      ".bh-submit-btn.bh-loading .bh-spinner { display: inline-block; }",
      ".bh-submit-btn.bh-loading .bh-btn-text { opacity: 0.7; }",
      "@keyframes bh-spin { to { transform: rotate(360deg); } }",
      ".bh-form-msg { font-size: 13px; margin-top: 8px; }",
      ".bh-form-msg.bh-success { color: #333; }",
      ".bh-form-msg.bh-error { color: #c00; }",
      ".bh-no-comments { text-align: center; color: #999; padding: 24px 0; font-size: 14px; }",
      /* Markdown styles */
      ".bh-comment-content code.bh-md-code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }",
      ".bh-comment-content pre.bh-md-pre { background: #f5f5f5; padding: 10px 12px; border-radius: 5px; overflow-x: auto; margin: 6px 0; }",
      ".bh-comment-content pre.bh-md-pre code { background: none; padding: 0; font-size: 0.9em; }",
      ".bh-comment-content blockquote.bh-md-bq { border-left: 3px solid #ddd; margin: 6px 0; padding: 4px 12px; color: #666; }",
      ".bh-comment-content ul.bh-md-ul, .bh-comment-content ol.bh-md-ol { margin: 6px 0; padding-left: 20px; }",
      ".bh-comment-content ul.bh-md-ul li, .bh-comment-content ol.bh-md-ol li { margin: 2px 0; }",
      ".bh-comment-content img.bh-md-img { max-width: 100%; border-radius: 5px; margin: 6px 0; }",
      ".bh-comment-content del { color: #999; }",
      /* Sidebar comments */
      ".ba-sidebar-comments { border-top: 1px solid #e1e4e8; padding-top: 16px; margin-top: 4px; }",
      ".ba-sidebar-comments .ba-sc-item { margin-bottom: 4px; display: flex; align-items: flex-start; }",
      ".ba-sidebar-comments .ba-sc-item .ba-sc-content { flex: 1; min-width: 0; font-size: 13px; color: #586069; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; cursor: pointer; border-radius: 3px; padding: 2px 4px; transition: all 0.2s; }",
      ".ba-sidebar-comments .ba-sc-item .ba-sc-content:hover { color: #0366d6; background-color: #f1f8ff; }",
      ".ba-sidebar-comments .ba-sc-meta { font-size: 12px; color: #586069; white-space: nowrap; flex-shrink: 0; padding-left: 6px; }",
      /* Page reactions */
      ".bh-page-reactions { margin-top: 16px; padding: 8px 0; display: flex; justify-content: flex-end; }",
      ".bh-page-reactions .bh-page-react-btn { background: none; border: 1px solid #e0e0e0; font-size: 20px; cursor: pointer; padding: 8px 16px; border-radius: 24px; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s; filter: grayscale(1); opacity: 0.45; }",
      ".bh-page-reactions .bh-page-react-btn:hover { filter: grayscale(0); opacity: 1; border-color: #ff6b6b; background: #fff5f5; }",
      ".bh-page-reactions .bh-page-react-btn.bh-active { filter: grayscale(0); opacity: 1; border-color: #ff6b6b; background: #fff5f5; }",
      ".bh-page-reactions .bh-page-react-count { font-size: 16px; color: #999; }",
      ".bh-page-reactions .bh-page-react-btn.bh-active .bh-page-react-count { color: #e25555; }",
      /* Markdown preview tabs */
      ".bh-editor-tabs { display: flex; gap: 0; border-bottom: 1px solid #ddd; margin-bottom: 8px; }",
      ".bh-editor-tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 4px 12px; font-size: 13px; color: #999; cursor: pointer; transition: all 0.15s; }",
      ".bh-editor-tab:hover { color: #555; }",
      ".bh-editor-tab.bh-tab-active { color: #333; border-bottom-color: #333; }",
      ".bh-md-preview { min-height: 100px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 5px; font-size: 14px; line-height: 1.6; color: #333; background: #fafafa; overflow-y: auto; max-height: 300px; word-break: break-word; }",
      ".bh-md-preview p { margin: 0 0 8px; }",
      ".bh-md-preview p:last-child { margin-bottom: 0; }",
      ".bh-md-preview pre { background: #f5f5f5; padding: 10px 12px; border-radius: 5px; overflow-x: auto; margin: 6px 0; }",
      ".bh-md-preview code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }",
      ".bh-md-preview pre code { background: none; padding: 0; }",
      ".bh-md-preview blockquote { border-left: 3px solid #ddd; margin: 6px 0; padding: 4px 12px; color: #666; }",
      ".bh-md-preview img { max-width: 100%; border-radius: 5px; }",
      ".bh-md-preview a { color: #0366d6; }",
      ".bh-md-preview ul, .bh-md-preview ol { margin: 6px 0; padding-left: 20px; }",
      ".bh-md-hint { font-size: 11px; color: #bbb; margin-top: 4px; }",
      ".bh-md-hint a { color: #bbb; text-decoration: none; }",
      ".bh-md-hint a:hover { color: #999; }",
    ].join("\n");
    document.head.appendChild(style);
  }

  // ============================================================
  // 6a-1. Page-level Reactions (heart for articles)
  // ============================================================

  function renderPageReactions(config, slug) {
    var container = document.querySelector(config.selectors.postContainer);
    if (!container) return;

    injectCommentStyles();

    var bar = document.createElement("div");
    bar.className = "bh-page-reactions";
    container.appendChild(bar);

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
        emoji + (count > 0 ? ' <span class="bh-page-react-count">' + count + '</span>' : '') +
        '</button>';

      // Bind click with optimistic update (same pattern as comment reactions)
      var btn = bar.querySelector(".bh-page-react-btn");
      btn.addEventListener("click", function () {
        var isActive = btn.classList.contains("bh-active");
        var action = isActive ? "remove" : "add";

        // Optimistic UI update
        var countEl = btn.querySelector(".bh-page-react-count");
        var currentCount = countEl ? parseInt(countEl.textContent) : 0;
        var newCount = action === "add" ? currentCount + 1 : Math.max(0, currentCount - 1);
        if (newCount > 0) {
          if (countEl) {
            countEl.textContent = newCount;
          } else {
            var span = document.createElement("span");
            span.className = "bh-page-react-count";
            span.textContent = newCount;
            btn.appendChild(document.createTextNode(" "));
            btn.appendChild(span);
          }
        } else if (countEl) {
          if (countEl.previousSibling && countEl.previousSibling.nodeType === 3) {
            countEl.previousSibling.remove();
          }
          countEl.remove();
        }
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

    injectCommentStyles();

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
    var textarea = form.querySelector("textarea");
    if (textarea) textarea.focus();
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

    // Build tooltip for author hover: blog_url | bio
    var tooltipParts = [];
    if (blogUrl) tooltipParts.push(escapeHtml(blogUrl));
    if (a.bio) tooltipParts.push(escapeHtml(a.bio));
    var tooltip = tooltipParts.length > 0 ? ' title="' + tooltipParts.join(' | ') + '"' : '';

    var authorTag = blogUrl ?
      '<a class="bh-comment-author" href="' + escapeHtml(blogUrl) + '" target="_blank" rel="noopener"' + tooltip + '>' + escapeHtml(a.nickname || "匿名") + '</a>' :
      '<span class="bh-comment-author"' + tooltip + '>' + escapeHtml(a.nickname || "匿名") + '</span>';

    var replyRef = "";
    if (isReply && c.parent_id) {
      var parent = commentMap[c.parent_id];
      if (parent && parent.author) {
        replyRef = '<span class="bh-reply-to">回复 @' + escapeHtml(parent.author.nickname) + '</span>';
      }
    }

    return '<div class="bh-comment-item' + (isReply ? ' bh-comment-reply' : '') + '" data-id="' + c.id + '" id="comment-' + c.id + '">' +
      '<img class="bh-comment-avatar" src="' + avatar + '" alt=""' +
        ' style="width:' + avatarSize + 'px;height:' + avatarSize + 'px">' +
      '<div class="bh-comment-body">' +
        '<div class="bh-comment-header">' +
          authorTag +
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
      // Logged-in: show user badge in header with hover tooltip
      var avatar = generateAvatar(me.nickname || '?', 24);
      var tooltipLines = escapeHtml(me.nickname || '');
      if (me.bio) tooltipLines += '\n' + escapeHtml(me.bio);
      var meBlogUrl = normalizeBlogUrl(me.blog_url);
      formHeader =
        '<div class="bh-form-header">' +
          '<div class="bh-comment-form-title">写评论</div>' +
          '<div class="bh-user-badge">' +
            '<img class="bh-user-badge-avatar" src="' + avatar + '" alt="">' +
            '<span class="bh-user-badge-name">' + escapeHtml(me.nickname) + '</span>' +
            '<div class="bh-user-tooltip">' +
              '<div class="bh-user-tooltip-row"><strong>' + escapeHtml(me.nickname) + '</strong></div>' +
              (me.bio ? '<div class="bh-user-tooltip-row bh-user-tooltip-bio">' + escapeHtml(me.bio) + '</div>' : '') +
              (meBlogUrl ? '<div class="bh-user-tooltip-row"><a href="' + escapeHtml(meBlogUrl) + '" target="_blank" rel="noopener">' + escapeHtml(meBlogUrl) + '</a></div>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      identityFields = '<input type="hidden" name="has_token" value="1">';
    } else {
      formHeader = '<div class="bh-comment-form-title">写评论</div>';
      identityFields =
        '<div class="bh-form-identity">' +
          '<div class="bh-form-row"><label>昵称 <span class="bh-required">*</span></label><input type="text" name="nickname" placeholder="你的名字"></div>' +
          '<div class="bh-form-row"><label>邮箱 <span class="bh-required">*</span> <span class="bh-hint">不公开</span></label><input type="email" name="email" placeholder="your@email.com" required></div>' +
        '</div>' +
        '<div class="bh-form-identity" style="margin-top:12px">' +
          '<div class="bh-form-row"><label>博客地址 <span class="bh-optional">可选</span></label><input type="text" name="blog_url" placeholder="example.com"></div>' +
          '<div class="bh-form-row"><label>个性签名 <span class="bh-optional">可选</span></label><input type="text" name="bio" placeholder="一句话介绍自己"></div>' +
        '</div>';
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
        '<textarea name="content" placeholder="写下你的想法...支持 Markdown" maxlength="1024" required></textarea>' +
        '<div class="bh-md-preview" style="display:none"></div>' +
        '<div class="bh-md-hint">支持 <a href="https://commonmark.org/help/" target="_blank" rel="noopener">Markdown</a> 语法</div>' +
      '</div>' +
      '<button type="button" class="bh-submit-btn"><span class="bh-spinner"></span><span class="bh-btn-text">提交评论</span></button>' +
      '<div class="bh-form-msg"></div>' +
      '<div style="position:absolute;left:-9999px"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>';

    // Cancel reply
    var cancelBtn = form.querySelector(".bh-reply-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        state.replyTo = null;
        hideCommentForm(section);
      });
    }

    // Email onBlur lookup
    var emailInput = form.querySelector('input[name="email"]');
    if (emailInput) {
      emailInput.addEventListener("blur", function () {
        var email = this.value.trim();
        if (!email) return;
        apiLookupCommenter(config, email).then(function (data) {
          if (data) {
            // Pre-fill fields
            var nn = form.querySelector('input[name="nickname"]');
            var bl = form.querySelector('input[name="blog_url"]');
            var bio = form.querySelector('input[name="bio"]');
            if (nn && !nn.value) nn.value = data.nickname || "";
            if (bl && !bl.value) bl.value = data.blog_url || "";
            if (bio && !bio.value) bio.value = data.bio || "";
            // Show welcome back
            var msg = form.querySelector(".bh-form-msg");
            if (msg) {
              msg.className = "bh-form-msg bh-success";
              msg.textContent = "欢迎回来，" + (data.nickname || "");
            }
          }
        });
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

      // Show loading + solve PoW challenge
      submitBtn.classList.add("bh-loading");
      submitBtn.disabled = true;
      msgEl.className = "bh-form-msg";
      msgEl.textContent = "验证中...";

      apiGetChallenge(config).then(function (challengeData) {
        if (!challengeData) throw new Error("无法获取验证信息");
        msgEl.textContent = "计算中...";
        return solveChallenge(challengeData.challenge).then(function (answer) {
          return { challenge: challengeData.challenge, answer: answer };
        });
      }).then(function (proof) {
        msgEl.textContent = "提交中...";
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
        submitBtn.classList.remove("bh-loading");
        submitBtn.disabled = false;

        if (resp.ok) {
          // Save token
          if (resp.data.token) {
            setCommenterToken(resp.data.token);
          }
          if (resp.data.me) {
            state.me = resp.data.me;
          }
          // Add to list
          if (resp.data.comment) {
            state.comments.push(resp.data.comment);
          }
          state.replyTo = null;
          renderCommentList(section, state, config);
          hideCommentForm(section);
        } else {
          msgEl.className = "bh-form-msg bh-error";
          msgEl.textContent = resp.error ? resp.error.message : "提交失败";
        }
      }).catch(function (err) {
        submitBtn.classList.remove("bh-loading");
        submitBtn.disabled = false;
        msgEl.className = "bh-form-msg bh-error";
        msgEl.textContent = err.message || "提交失败";
      });
    });
  }

  // ============================================================
  // 6b. Sidebar Comment Widgets
  // ============================================================

  function sidebarCommentTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var now = new Date();
    var diff = Math.floor((now - d) / 1000);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
    if (diff < 2592000) return Math.floor(diff / 86400) + "天前";
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function sidebarCommentLink(c) {
    var author = c.author ? c.author.nickname : "匿名";
    var text = (c.content || "").replace(/\n/g, " ").substring(0, 50);
    var href = escapeHtml(c.page_slug) + "#comment-" + c.id;
    var display = author + "回复: " + text;

    // Right side: time / emoji
    var metaParts = [];
    var time = sidebarCommentTime(c.created_at);
    if (time) metaParts.push(time);
    var reactions = c.reactions || [];
    for (var i = 0; i < reactions.length; i++) {
      metaParts.push(reactions[i].emoji + reactions[i].count);
    }
    var meta = metaParts.length > 0 ? '<span class="ba-sc-meta">' + metaParts.join(" ") + '</span>' : '';

    return '<span class="ba-sc-content" data-href="' + href + '" title="' + escapeHtml(author + ': ' + (c.content || '')) + '">' +
      escapeHtml(display) + '</span>' + meta;
  }

  function renderRecentComments(config, comments) {
    if (!comments || comments.length === 0) return;
    var mount = document.querySelector("#bh-recent-comments-mount") ||
                document.querySelector(config.selectors.sidebarMount);
    if (!mount) return;

    var html = '<div class="sidebar-section ba-sidebar-comments">';
    html += '<div class="sidebar-title">Recent Comments</div>';
    for (var i = 0; i < comments.length; i++) {
      html += '<div class="ba-sc-item">' + sidebarCommentLink(comments[i]) + '</div>';
    }
    html += '</div>';
    var el = createElementFromHTML(html);
    bindSidebarCommentClicks(el);
    mount.appendChild(el);
  }

  function renderHotComments(config, comments) {
    if (!comments || comments.length === 0) return;
    var mount = document.querySelector("#bh-hot-comments-mount") ||
                document.querySelector(config.selectors.sidebarMount);
    if (!mount) return;

    var html = '<div class="sidebar-section ba-sidebar-comments">';
    html += '<div class="sidebar-title">Hot Comments</div>';
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

    // Comment section + page reactions (post pages only)
    // Auto-detect: if showComments not explicitly set, probe backend
    if (pageType === "post") {
      var commentSlug = getCurrentSlug();
      if (config.features.showComments) {
        promises.push(
          Promise.resolve().then(function () {
            renderPageReactions(config, commentSlug);
            renderCommentSection(config, commentSlug);
          })
        );
      } else {
        // Auto-detect from backend
        promises.push(
          fetch(commentApiBase(config) + "/comments/config", { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.ok && d.data && d.data.enabled) {
                renderPageReactions(config, commentSlug);
                renderCommentSection(config, commentSlug);
              }
            })
            .catch(function () { /* comments not available, silent */ })
        );
      }
    }

    // Sidebar: recent comments + hot comments (if comments enabled)
    var sidebarCommentPromise = fetch(commentApiBase(config) + "/comments/config", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !d.data || !d.data.enabled) return;
        return Promise.all([
          apiRecentComments(config, 5).then(function (data) { renderRecentComments(config, data); }),
          apiHotComments(config, 5).then(function (data) { renderHotComments(config, data); }),
        ]);
      })
      .catch(function () { /* silent */ });
    promises.push(sidebarCommentPromise);

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
