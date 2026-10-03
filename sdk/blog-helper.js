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
      showListAll: false,
      showPostStats: true,
      showPopular: true,
      popularLimit: 8,
      popularPeriod: "all",
      popularPrefix: "",
      popularExclude: "",
      popularCacheTTL: 3600000,
      showActive: false,
      showTrend: false,
      showReferrers: false,
      activeMinutes: 30,
      trendDays: 30,
      referrersDays: 30,
      referrersLimit: 10,
      showComments: "auto",
      showInlineComments: true, // text-anchored inline comments (select text → comment → highlight)
      shareAvatar: "",          // QR-center avatar path; empty = auto-probe /asset/img/avator.{png,jpg}
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

  function apiPopular(config, limit, period, prefix, exclude) {
    var url = "/popular?limit=" + limit + "&period=" + period + "&site_id=" + encodeURIComponent(config.siteId);
    if (prefix) url += "&prefix=" + encodeURIComponent(prefix);
    if (exclude) url += "&exclude=" + encodeURIComponent(exclude);
    return apiRequest(config, "GET", url);
  }

  function cachedPopular(config) {
    var ttl = config.features.popularCacheTTL;
    var key = "bh_popular_" + config.siteId;
    if (ttl > 0) {
      try {
        var cached = localStorage.getItem(key);
        if (cached) {
          var obj = JSON.parse(cached);
          if (Date.now() - obj.ts < ttl) {
            return Promise.resolve(obj.data);
          }
        }
      } catch (e) {}
    }
    return apiPopular(
      config,
      config.features.popularLimit,
      config.features.popularPeriod,
      config.features.popularPrefix,
      config.features.popularExclude
    ).then(function (articles) {
      if (ttl > 0) {
        try {
          localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: articles }));
        } catch (e) {}
      }
      return articles;
    });
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

  function renderListAll(config, statsMap, reactionsMap) {
    if (!statsMap) statsMap = {};
    if (!reactionsMap) reactionsMap = {};
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
      var reactions = reactionsMap[slug];
      var uv = stats ? stats.uv : 0;
      var pv = stats ? stats.pv : 0;
      var likes = 0;
      if (reactions && reactions["❤️"]) {
        likes = reactions["❤️"];
      }

      // Build display parts (skip zero values)
      var parts = [];
      if (uv > 0) parts.push(config.uvLabel + " " + uv);
      if (pv > 0) parts.push(config.pvLabel + " " + pv);
      if (likes > 0) parts.push("❤️ " + likes);

      if (parts.length === 0) {
        var existing = item.querySelector(".ba-pv");
        if (existing) existing.style.display = "none";
        continue;
      }

      var el = item.querySelector(".ba-pv");
      if (!el) {
        el = document.createElement("span");
        el.className = "ba-pv";
        item.appendChild(el);
      }
      el.className = "ba-pv ba-stats-all ba-pv-ready";
      el.textContent = parts.join(config.separator);
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

  function apiPageReactionsBatch(config, slugs) {
    var base = commentApiBase(config);
    return fetch(base + "/page/reactions/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ site_id: config.siteId, slugs: slugs }),
    }).then(function (r) { return r.json(); })
      .then(function (d) { return d.ok ? d.data : {}; })
      .catch(function () { return {}; });
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

  function apiUpdateComment(config, id, content) {
    var base = commentApiBase(config);
    return fetch(base + "/comments/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id: id, content: content }),
    }).then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: { message: "Network error" } }; });
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
    // If the container is a top-level wrapper (parent is <body>), inserting as a sibling
    // would escape the page's width constraint (e.g. md2site ".container") — append
    // inside the container instead so comments stay in the content column.
    if (container.parentNode === document.body) {
      container.appendChild(section);
    } else if (container.nextSibling) {
      container.parentNode.insertBefore(section, container.nextSibling);
    } else {
      container.parentNode.appendChild(section);
    }

    // State
    var state = {
      comments: [],
      me: null,
      replyTo: null,
      anchor: null, // inline-comment anchor being written (null = whole-page comment)
    };

    // Keep a stable reference to the form element — it may be temporarily
    // moved into an inline-comment popover.
    section._bhFormEl = section.querySelector(".bh-comment-form");

    // Inline comments (text-anchored annotations)
    initInlineComments(section, state, config, slug);

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
    var form = section.querySelector(".bh-comment-form") || section._bhFormEl;
    if (trigger) trigger.style.display = "none";
    if (!form) return;
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
    var form = section.querySelector(".bh-comment-form") || section._bhFormEl;
    if (trigger) trigger.style.display = "";
    if (form) form.style.display = "none";
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

    // Click the avatar / author name to open the commenter card
    // (showCommenterCard — full profile, email deliberately excluded)
    var isAdmin = a.id === 0;
    var adminBadge = isAdmin ? '<span class="bh-admin-badge">Author</span>' : '';
    var canEdit = !isAdmin && commentMap._me && a.id === commentMap._me.id;
    var authorName = blogUrl ?
      '<a class="bh-comment-author bh-cc-trigger" href="' + escapeHtml(blogUrl) + '" target="_blank" rel="noopener">' + escapeHtml(a.nickname || "匿名") + '</a>' + adminBadge :
      '<span class="bh-comment-author bh-cc-trigger">' + escapeHtml(a.nickname || "匿名") + '</span>' + adminBadge;

    var replyRef = "";
    if (isReply && c.parent_id) {
      var parent = commentMap[c.parent_id];
      if (parent && parent.author) {
        replyRef = '<span class="bh-reply-to">回复 @' + escapeHtml(parent.author.nickname) + '</span>';
      }
    }

    // Inline-comment quote: the body text this comment is anchored to
    var quoteBlock = "";
    if (c.anchor) {
      var a = parseAnchor(c.anchor);
      if (a && a.exact) {
        quoteBlock = '<div class="bh-quote" data-cid="' + c.id + '" title="点击跳转到正文">“' +
          escapeHtml(a.exact.length > 120 ? a.exact.slice(0, 120) + "…" : a.exact) + '”</div>';
      }
    }

    return '<div class="bh-comment-item' + (isReply ? ' bh-comment-reply' : '') + '" data-id="' + c.id + '" id="comment-' + c.id + '">' +
      '<span class="bh-comment-author-wrap">' +
        '<img class="bh-comment-avatar bh-cc-trigger" src="' + avatar + '" alt=""' +
          ' style="width:' + avatarSize + 'px;height:' + avatarSize + 'px">' +
      '</span>' +
      '<div class="bh-comment-body">' +
        '<div class="bh-comment-header">' +
          '<span class="bh-comment-author-wrap">' + authorName + '</span>' +
          replyRef +
          '<span class="bh-comment-meta">' +
            '<span class="bh-comment-time">' + formatTime(c.created_at) + '</span>' +
            '<a class="bh-comment-anchor" href="#comment-' + c.id + '" title="链接到此评论">#</a>' +
          '</span>' +
        '</div>' +
        '<div class="bh-comment-content">' + quoteBlock + renderMarkdown(c.content) + '</div>' +
        '<div class="bh-comment-actions">' +
          renderReactionButtons(c) +
          '<button class="bh-reply-btn" data-id="' + c.id + '">回复</button>' +
          (canEdit ? '<button class="bh-edit-btn" data-id="' + c.id + '">编辑</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // Reaction buttons (shared by the bottom comment list and the anchor popover)
  function bindReactionButtons(scope, state, config, commentMap) {
    var btns = scope.querySelectorAll(".bh-reaction");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
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

    // Store commentMap on state for reply button access (plus current user,
    // consumed by renderCommentItem to decide whether to show the edit button)
    commentMap._me = state.me || null;
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

    // Bind edit buttons (own comments only)
    var ebtns = list.querySelectorAll(".bh-edit-btn");
    for (var ei = 0; ei < ebtns.length; ei++) {
      ebtns[ei].addEventListener("click", function () {
        var id = parseInt(this.getAttribute("data-id"));
        startCommentEdit(section, state, config, id, list);
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
    bindReactionButtons(list, state, config, commentMap);

    // Click avatar / author name → commenter card
    bindCommenterCards(list, state, commentMap);

    // Bind inline-comment quote blocks — click to jump back to the highlighted text
    var quotes = list.querySelectorAll(".bh-quote");
    for (var qI = 0; qI < quotes.length; qI++) {
      quotes[qI].addEventListener("click", function () {
        var cid = this.getAttribute("data-cid");
        var scope = (section._bhInline && section._bhInline.container) || document;
        var marks = scope.querySelectorAll("span.bh-hl");
        for (var mI = 0; mI < marks.length; mI++) {
          var cids = (marks[mI].getAttribute("data-cids") || "").split(",");
          if (cids.indexOf(cid) !== -1) {
            marks[mI].scrollIntoView({ behavior: "smooth", block: "center" });
            marks[mI].classList.remove("bh-hl-flash");
            void marks[mI].offsetWidth;
            marks[mI].classList.add("bh-hl-flash");
            return;
          }
        }
      });
    }

    // Refresh inline highlights (comments may have changed)
    if (section._bhRefreshInline) section._bhRefreshInline();
  }

  // Commenter card — click the avatar / author name to open. Fixed-positioned
  // next to the trigger with boundary awareness. Email is deliberately NOT
  // shown (privacy); the card shows avatar, nickname, bio, blog and the
  // author's comment count on this page.
  var _ccCard = null;

  function closeCommenterCard() {
    if (!_ccCard) return;
    if (_ccCard._bhCleanup) {
      for (var i = 0; i < _ccCard._bhCleanup.length; i++) _ccCard._bhCleanup[i]();
    }
    if (_ccCard.parentNode) _ccCard.parentNode.removeChild(_ccCard);
    _ccCard = null;
  }

  function showCommenterCard(comment, triggerEl, state) {
    closeCommenterCard();
    var a = comment.author || {};
    var isAdmin = a.id === 0;
    var count = 0;
    var list = (state && state.comments) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].author && list[i].author.id === a.id) count++;
    }
    var blogUrl = normalizeBlogUrl(a.blog_url);

    var card = document.createElement("div");
    card.className = "bh-cc-card";
    card.innerHTML =
      '<div class="bh-cc-head">' +
        '<img class="bh-cc-avatar" src="' + generateAvatar(a.avatar_seed || a.nickname || "?", 56) + '" alt="">' +
        '<div class="bh-cc-id">' +
          '<div class="bh-cc-name">' + escapeHtml(a.nickname || "匿名") +
            (isAdmin ? ' <span class="bh-admin-badge">Author</span>' : '') + '</div>' +
          (a.bio ? '<div class="bh-cc-bio">' + escapeHtml(a.bio) + '</div>' : '') +
        '</div>' +
      '</div>' +
      (blogUrl ? '<a class="bh-cc-blog" href="' + escapeHtml(blogUrl) + '" target="_blank" rel="noopener">' +
        escapeHtml(blogUrl.replace(/^https?:\/\//, "")) + '</a>' : '') +
      '<div class="bh-cc-meta">本页评论 ' + count + ' 条</div>';
    document.body.appendChild(card);
    _ccCard = card;

    // position: below the trigger, boundary-aware (flip above / clamp left)
    var r = triggerEl.getBoundingClientRect();
    card.style.visibility = "hidden";
    card.style.display = "";
    var pw = card.offsetWidth, ph = card.offsetHeight;
    var left = r.left;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, r.right - pw);
    var top = r.bottom + 10;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 10);
    card.style.left = left + "px";
    card.style.top = top + "px";
    card.style.visibility = "";

    // close on Esc / outside click / scroll
    var onKey = function (e) { if (e.key === "Escape") closeCommenterCard(); };
    var onDown = function (e) { if (!card.contains(e.target)) closeCommenterCard(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    card._bhCleanup = [
      function () { document.removeEventListener("keydown", onKey); },
      function () { document.removeEventListener("mousedown", onDown, true); },
    ];
  }

  // Click delegation for avatar / author name (comment list + anchor popover)
  function bindCommenterCards(scope, state, commentMap) {
    if (scope._ccBound) return;
    scope._ccBound = true;
    scope.addEventListener("click", function (e) {
      var trig = e.target && e.target.closest ? e.target.closest(".bh-cc-trigger") : null;
      if (!trig) return;
      var item = trig.closest(".bh-comment-item");
      if (!item) return;
      var id = parseInt(item.getAttribute("data-id"));
      var comment = commentMap ? commentMap[id] : null;
      if (!comment) return;
      e.preventDefault();
      showCommenterCard(comment, trig, state);
    });
  }

  // Inline editor for one's own comment: swaps the rendered content for a
  // textarea (Markdown), saves via /comments/update, then re-renders the list.
  function startCommentEdit(section, state, config, commentID, scope) {
    var item = (scope || document).querySelector('.bh-comment-item[data-id="' + commentID + '"]');
    if (!item || item.querySelector(".bh-edit-area")) return;
    var comment = (state._commentMap || {})[commentID];
    if (!comment) return;

    var contentEl = item.querySelector(".bh-comment-content");
    var original = comment.content || "";
    var editor = document.createElement("div");
    editor.className = "bh-edit-area";
    editor.innerHTML =
      '<textarea class="bh-edit-text" maxlength="1024">' + escapeHtml(original) + '</textarea>' +
      '<div class="bh-edit-actions">' +
        '<button type="button" class="bh-edit-save">保存</button>' +
        '<button type="button" class="bh-edit-cancel">取消</button>' +
        '<span class="bh-edit-msg"></span>' +
      '</div>';
    contentEl.style.display = "none";
    contentEl.parentNode.insertBefore(editor, contentEl.nextSibling);

    editor.querySelector(".bh-edit-cancel").addEventListener("click", function () {
      editor.remove();
      contentEl.style.display = "";
    });
    editor.querySelector(".bh-edit-save").addEventListener("click", function () {
      var ta = editor.querySelector(".bh-edit-text");
      var msg = editor.querySelector(".bh-edit-msg");
      var content = ta.value.trim();
      if (!content) { msg.textContent = "内容不能为空"; return; }
      if (content.length > 1024) { msg.textContent = "不能超过 1024 字符"; return; }
      var saveBtn = this;
      saveBtn.disabled = true;
      apiUpdateComment(config, commentID, content).then(function (resp) {
        saveBtn.disabled = false;
        if (!resp.ok) {
          msg.textContent = (resp.error && resp.error.message) || "保存失败";
          return;
        }
        // update local state and re-render
        comment.content = content;
        comment.status = (resp.data && resp.data.status) || comment.status;
        if (comment.status !== "approved") {
          // moderation mode: edited comment back to pending — drop from live list
          var idx = state.comments.indexOf(comment);
          if (idx !== -1) state.comments.splice(idx, 1);
        }
        renderCommentList(section, state, config);
      });
    });
    editor.querySelector(".bh-edit-text").focus();
  }

  function renderCommentForm(section, state, config, slug, mountOverride) {
    slug = slug || getCurrentSlug();
    var form = mountOverride || section.querySelector(".bh-comment-form");
    if (!form) return;
    var me = state.me;
    var hasToken = !!me; // token is HttpOnly; rely on server-set state.me

    var formHeader = '';
    var identityFields = '';

    if (me && hasToken) {
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

      if (!hasToken) {
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
          anchor: state.anchor ? JSON.stringify(state.anchor) : "",
          fingerprint: _fingerprintCache || "",
          challenge: proof.challenge,
          answer: proof.answer,
        });
      }).then(function (resp) {
        overlay.style.display = "none";
        submitBtn.disabled = false;

        if (resp.ok) {
          // Token is set as HttpOnly cookie by the server response
          if (resp.data.me) {
            state.me = resp.data.me;
          }
          // Add to list (only if approved)
          var newComment = resp.data.comment;
          if (newComment && newComment.status === "approved") {
            state.comments.push(newComment);
          }
          state.replyTo = null;
          state.anchor = null;
          renderCommentList(section, state, config);
          // Inline-comment popover: refresh its comment list instead of hiding the form
          var pop = form.closest ? form.closest(".bh-anchor-popover") : null;
          if (pop && pop._bhOnPosted) {
            pop._bhOnPosted(newComment);
          } else {
            hideCommentForm(section);
          }
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
  // 6c. Inline Comments (text-anchored annotations)
  //
  // Select text in the article → floating "评论这段" bubble → comment with a
  // content-addressed anchor (W3C-Web-Annotation-style TextQuoteSelector:
  // {exact, prefix, suffix, start, end}). On load, anchors are resolved back
  // to DOM ranges and wrapped in <span class="bh-hl"> highlights. Clicking a
  // highlight opens a popover with the comments on that passage; the quote in
  // the bottom comment list jumps back to the highlight.
  // ============================================================

  var ANCHOR_CONTEXT = 32; // chars of prefix/suffix stored around the selection

  function throttle(fn, ms) {
    var last = 0, timer = null;
    return function () {
      var now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn();
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = null;
          last = Date.now();
          fn();
        }, ms - (now - last));
      }
    };
  }

  function parseAnchor(raw) {
    if (!raw) return null;
    try {
      var a = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!a || !a.exact || typeof a.exact !== "string") return null;
      return a;
    } catch (e) {
      return null;
    }
  }

  // Build an anchor for the current selection (Range) within container.
  function buildAnchor(range, container) {
    var fullText = container.textContent;
    var pre = document.createRange();
    pre.setStart(container, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    var start = pre.toString().length;
    var exact = range.toString();
    if (!exact) return null;
    return {
      exact: exact,
      prefix: fullText.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
      suffix: fullText.slice(start + exact.length, start + exact.length + ANCHOR_CONTEXT),
      start: start,
      end: start + exact.length,
    };
  }

  // Resolve an anchor to {start, end} offsets in container.textContent.
  // Strategy: position-first with exact-text verification, then fall back to
  // prefix+exact+suffix search, then plain exact search. Returns null if the
  // passage no longer exists (comment degrades to quote-only display).
  function resolveAnchor(a, container) {
    var fullText = container.textContent;
    if (typeof a.start === "number" && typeof a.end === "number" &&
        a.start >= 0 && a.end <= fullText.length && a.end > a.start) {
      if (fullText.slice(a.start, a.end) === a.exact) {
        return { start: a.start, end: a.end };
      }
    }
    var pre = a.prefix || "";
    var probe = pre + a.exact + (a.suffix || "");
    var idx = fullText.indexOf(probe);
    if (idx >= 0) return { start: idx + pre.length, end: idx + pre.length + a.exact.length };
    idx = fullText.indexOf(a.exact);
    if (idx >= 0) return { start: idx, end: idx + a.exact.length };
    return null;
  }

  // Create a DOM Range from character offsets in container.textContent.
  function rangeFromOffsets(container, start, end) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    var node, offset = 0, started = false;
    var range = document.createRange();
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (!started && offset + len >= start) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && offset + len >= end) {
        range.setEnd(node, end - offset);
        return range;
      }
      offset += len;
    }
    return null;
  }

  // Wrap the text-node portions of a range in one <span class="bh-hl"> each.
  // Per-text-node wrapping is layout-safe for any selection (crossing inline
  // elements, bare text next to <p>s, multiple blocks) — the same approach
  // browser find-in-page uses. Returns the marks created (empty on failure).
  function wrapRangeMarks(range) {
    var marks = [];
    var root = range.commonAncestorContainer;
    var el = root.nodeType === 3 ? root.parentNode : root;
    if (!el) return marks;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (range.intersectsNode && !range.intersectsNode(node)) continue;
      var startOff = 0;
      var endOff = node.nodeValue.length;
      if (node === range.startContainer) startOff = range.startOffset;
      if (node === range.endContainer) endOff = range.endOffset;
      if (endOff <= startOff) continue;
      var r = document.createRange();
      r.setStart(node, startOff);
      r.setEnd(node, endOff);
      var mark = document.createElement("span");
      mark.className = "bh-hl";
      try {
        r.surroundContents(mark);
        marks.push(mark);
      } catch (e) {
        /* skip this segment */
      }
    }
    return marks;
  }

  function clearHighlights(container) {
    var marks = container.querySelectorAll("span.bh-hl");
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      // Keep temporary deep-link highlights (no data-cids) — they are not
      // backed by comments and would otherwise vanish when comments refresh.
      if (m.id && m.id.indexOf("bh-") === 0 && !m.getAttribute("data-cids")) continue;
      var parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    }
    container.normalize();
  }

  // Resolve all anchored comments, group by position, and paint highlights.
  function renderInlineHighlights(section, state) {
    var inline = section._bhInline;
    if (!inline || !inline.content) return;
    var container = inline.content;
    clearHighlights(container);

    var groups = {};
    var ordered = [];
    for (var i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      if (!c.anchor) continue;
      var a = parseAnchor(c.anchor);
      if (!a) continue;
      var pos = resolveAnchor(a, container);
      if (!pos) continue; // passage gone — quote still shows in the comment list
      var key = pos.start + ":" + pos.end;
      if (!groups[key]) {
        groups[key] = { start: pos.start, end: pos.end, cids: [] };
        ordered.push(groups[key]);
      }
      groups[key].cids.push(c.id);
    }

    // Wrap from last to first so earlier offsets stay valid; skip overlaps.
    ordered.sort(function (x, y) { return y.start - x.start; });
    var acceptedStart = Infinity;
    var acceptedMarks = null;
    for (var g = 0; g < ordered.length; g++) {
      var grp = ordered[g];
      if (grp.end > acceptedStart) {
        // Overlapping passage (e.g. someone quoted a wider range): merge its
        // comments into the covering highlight so they stay reachable.
        if (acceptedMarks) {
          for (var om = 0; om < acceptedMarks.length; om++) {
            var existing = (acceptedMarks[om].getAttribute("data-cids") || "").split(",");
            for (var oc = 0; oc < grp.cids.length; oc++) {
              if (existing.indexOf(String(grp.cids[oc])) === -1) existing.push(String(grp.cids[oc]));
            }
            acceptedMarks[om].setAttribute("data-cids", existing.join(","));
          }
        }
        continue;
      }
      var r = rangeFromOffsets(container, grp.start, grp.end);
      if (!r) continue;
      var marks = wrapRangeMarks(r);
      if (marks.length) {
        for (var m = 0; m < marks.length; m++) {
          marks[m].setAttribute("data-cids", grp.cids.join(","));
        }
        // Deterministic id enables deep links (#bh-{start}-{end}) to this passage
        marks[0].id = "bh-" + grp.start + "-" + grp.end;
        acceptedStart = grp.start;
        acceptedMarks = marks;
      }
    }

    handleDeepLink(section);
  }

  // --- Share card (quote card with QR deep link) ---

  var _qrReady = false;
  var _qrLoading = false;
  var _qrCallbacks = [];

  // Share-card avatar in the QR center: probes candidate paths, caches the
  // first that loads; null when the site has none (QR renders without logo).
  var _shareAvatarState = "loading"; // "loading" | "ok" | "fail"
  var _shareAvatarImg = null;
  var _shareAvatarCallbacks = [];
  var SHARE_AVATAR_CANDIDATES = ["/asset/img/avator.png", "/asset/img/avator.jpg"];

  function loadShareAvatar(config, cb) {
    if (_shareAvatarState === "ok") return cb(_shareAvatarImg);
    if (_shareAvatarState === "fail") return cb(null);
    _shareAvatarCallbacks.push(cb);
    if (_shareAvatarImg) return; // already loading
    var candidates = (config && config.shareAvatar) ? [config.shareAvatar] : SHARE_AVATAR_CANDIDATES.slice();
    var idx = 0;
    function tryNext() {
      if (idx >= candidates.length) {
        _shareAvatarState = "fail";
        _shareAvatarImg = null;
        for (var j = 0; j < _shareAvatarCallbacks.length; j++) _shareAvatarCallbacks[j](null);
        _shareAvatarCallbacks = [];
        return;
      }
      var img = new Image();
      _shareAvatarImg = img;
      img.onload = function () {
        _shareAvatarState = "ok";
        for (var i = 0; i < _shareAvatarCallbacks.length; i++) _shareAvatarCallbacks[i](img);
        _shareAvatarCallbacks = [];
      };
      img.onerror = function () {
        idx++;
        tryNext();
      };
      img.src = candidates[idx];
    }
    tryNext();
  }

  function loadQrcode(cb) {
    if (_qrReady && window.qrcode) { cb(); return; }
    _qrCallbacks.push(cb);
    if (_qrLoading) return;
    _qrLoading = true;
    var script = document.createElement("script");
    // Load from local asset (same directory as blog-helper.js)
    var myScript = document.querySelector('script[src*="blog-helper"]');
    var baseDir = myScript ? myScript.src.replace(/[^\/]+$/, '') : 'asset/js/';
    script.src = baseDir + "qrcode.min.js";
    script.onload = function () {
      _qrReady = true;
      for (var i = 0; i < _qrCallbacks.length; i++) _qrCallbacks[i]();
      _qrCallbacks = [];
    };
    script.onerror = function () {
      _qrLoading = false;
      for (var i = 0; i < _qrCallbacks.length; i++) _qrCallbacks[i]();
      _qrCallbacks = [];
    };
    document.head.appendChild(script);
  }

  // Wrap text for canvas rendering (CJK-aware: break anywhere, prefer not
  // starting a line with closing punctuation).
  function canvasWrapText(ctx, text, maxWidth, maxLines) {
    var lines = [];
    var line = "";
    var noStart = "，。！？；：、）」』”…,.!?;:)]}\"'";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var next = line + ch;
      if (ctx.measureText(next).width > maxWidth && line) {
        if (noStart.indexOf(ch) !== -1 && line.length > 1) {
          // move last char of line down with the punctuation
          lines.push(line.slice(0, -1));
          line = line.slice(-1) + ch;
        } else {
          lines.push(line);
          line = ch;
        }
        if (maxLines && lines.length === maxLines) {
          return lines;
        }
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawQrcode(ctx, url, x, y, size, avatar) {
    // Error correction H (30%) so a center avatar (~22% of the size, same
    // approach as WeChat/Alipay QR logos) does not affect scannability.
    var qr = window.qrcode(0, "H");
    qr.addData(url);
    qr.make();
    var count = qr.getModuleCount();
    var cell = size / (count + 2); // include quiet zone
    ctx.fillStyle = "#fff";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#24292e";
    var offset = cell; // quiet zone
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(x + (c + 1) * cell, y + (r + 1) * cell, Math.ceil(cell), Math.ceil(cell));
        }
      }
    }
    if (avatar && avatar.width) {
      var a = size * 0.22;
      var cx = x + size / 2, cy = y + size / 2;
      // white ring around the avatar
      ctx.beginPath();
      ctx.arc(cx, cy, a / 2 + 5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      // circular-clipped avatar
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, a / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(avatar, cx - a / 2, cy - a / 2, a, a);
      ctx.restore();
    }
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Render the share card: quote + post title + site + QR deep link.
  // --- Share card render options (persisted per browser) ---
  // Styles are full layouts (header treatment + accent), not just colors.
  var SHARE_STYLES = {
    plain:    { label: "默认",   accent: "#f0ad4e", layout: "plain" },    // clean: no header, no quote mark
    serene:   { label: "宁静风", accent: "#2a7fb8", layout: "serene" },   // ocean banner + white title
    quote:    { label: "引用风", accent: "#f0ad4e", layout: "quote" },    // brand header + big quote mark
    calendar: { label: "日历风", accent: "#3d5a80", layout: "calendar" }, // date header
    bamboo:   { label: "竹简风", accent: "#8a6d3b", layout: "bamboo" },   // vertical, right-to-left
  };
  var SHARE_FONTS = {
    serif:   { label: "宋体", family: '"Songti SC", "SimSun", "Noto Serif SC", serif' },
    sans:    { label: "黑体", family: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
    kai:     { label: "楷体", family: '"Kaiti SC", "Kaiti TC", "STKaiti", "KaiTi", "DFKai-SB", "TW-Kai", serif' },
    fangsong:{ label: "仿宋", family: '"STFangsong", "FangSong", "FangSong_GB2312", serif' },
    yuanti:  { label: "圆体", family: '"Yuanti SC", "STXihei", "PingFang SC", sans-serif' },
  };
  var SHARE_BGS = {
    white: { label: "白", bg: "#ffffff", text: "#24292e", sub: "#586069", dark: false },
    dark:  { label: "夜", bg: "#1b1f24", text: "#e6e8ea", sub: "#9aa4ae", dark: true },
    cream: { label: "米", bg: "#f8f3e6", text: "#3b3226", sub: "#8a7c62", dark: false },
    mist:  { label: "灰", bg: "#eef1f5", text: "#24292e", sub: "#586069", dark: false },
    green: { label: "绿", bg: "#e9f2ea", text: "#22382a", sub: "#5f7a66", dark: false },
  };

  // Probe whether a font family actually resolves (vs silently falling back).
  // Compares latin glyph widths against a monospace baseline — reliable because
  // proportional CJK fonts render latin very differently from monospace.
  function shareFontAvailable(family) {
    try {
      var c = document.createElement("canvas").getContext("2d");
      c.font = '72px monospace';
      var mono = c.measureText("mmmmmmmmmmlli").width;
      c.font = '72px "' + family + '", monospace';
      return Math.abs(c.measureText("mmmmmmmmmmlli").width - mono) > 1;
    } catch (e) {
      return false;
    }
  }

  // First family of a font stack that is actually installed (for probing).
  function shareFontProbeName(family) {
    return String(family).split(",")[0].replace(/["']/g, "").trim();
  }

  function loadShareOpts() {
    try {
      var o = JSON.parse(localStorage.getItem("bh-share-opts") || "{}");
      // Migrate the pre-serif default: a stored "sans" font was almost always
      // the old default riding along when another option was changed.
      if (o.font === "sans") o.font = "serif";
      if (SHARE_STYLES[o.theme] && SHARE_FONTS[o.font] && SHARE_BGS[o.bg]) return o;
    } catch (e) { /* fall through */ }
    return { theme: "plain", font: "serif", bg: "white" };
  }

  function saveShareOpts(o) {
    try { localStorage.setItem("bh-share-opts", JSON.stringify(o)); } catch (e) { /* ignore */ }
  }

  var SHARE_LINE_H = 68;       // quote line height
  var SHARE_PARA_GAP = 40;     // extra gap between quoted paragraphs
  var SHARE_MAX_LINES = 80;    // hard cap for extremely long selections

  // Local time with timezone offset, e.g. "2026-10-04 00:30:15 UTC+8"
  function shareTimestamp() {
    var d = new Date();
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? "+" : "-";
    var oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
      " UTC" + sign + oh + (om ? ":" + pad(om) : "");
  }

  // Render the share card: quote (paragraph-aware, grows into a long image) +
  // post title + QR deep link + centered "@host" footer. Style driven by opts.
  function renderShareCard(quote, title, link, siteName, opts) {
    opts = opts || loadShareOpts();
    var style = SHARE_STYLES[opts.theme] || SHARE_STYLES.plain;
    var font = SHARE_FONTS[opts.font] || SHARE_FONTS.sans;
    var bgp = SHARE_BGS[opts.bg] || SHARE_BGS.white;

    var W = 1080;
    var PAD = 90;
    var maxW = W - PAD * 2;
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d");
    ctx.textBaseline = "top";
    var layout = style.layout;

    // Split the passage into paragraphs (selections across <p>s contain \n+)
    var paras = String(quote).split(/\n+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    if (paras.length === 0) paras = [String(quote).trim() || "..."];

    // measure: wrap every paragraph with the selected font
    var quoteFont = "46px " + font.family;
    ctx.font = quoteFont;

    // bamboo: traditional vertical layout — right-to-left columns, one
    // paragraph per column-set; groups of columns stack vertically (long image)
    var BAM_CHAR = 46, BAM_COL_ADV = 68, BAM_CHAR_ADV = 56, BAM_CHARS_PER_COL = 13;
    var BAM_MAX_GROUPS = 6;
    var bambooGroups = null;
    var quoteH;

    if (layout === "bamboo") {
      var maxColsPerRow = Math.floor(maxW / BAM_COL_ADV);
      var columns = [];
      for (var bp = 0; bp < paras.length; bp++) {
        var chars = paras[bp].split("");
        for (var bc = 0; bc < chars.length; bc += BAM_CHARS_PER_COL) {
          columns.push(chars.slice(bc, bc + BAM_CHARS_PER_COL));
        }
      }
      var maxCols = BAM_MAX_GROUPS * maxColsPerRow;
      if (columns.length > maxCols) {
        columns = columns.slice(0, maxCols);
        var lastCol = columns[columns.length - 1];
        lastCol[lastCol.length - 1] = "\u2026";
      }
      bambooGroups = [];
      for (var bg = 0; bg < columns.length; bg += maxColsPerRow) {
        bambooGroups.push(columns.slice(bg, bg + maxColsPerRow));
      }
      var groupH = BAM_CHARS_PER_COL * BAM_CHAR_ADV;
      quoteH = bambooGroups.length * groupH + (bambooGroups.length - 1) * 80;
    } else {
      var paraLines = [];
      var totalLines = 0;
      var capped = false;
      for (var pi = 0; pi < paras.length; pi++) {
        if (totalLines >= SHARE_MAX_LINES) { capped = true; break; }
        var remain = SHARE_MAX_LINES - totalLines;
        var lines = canvasWrapText(ctx, paras[pi], maxW, remain);
        paraLines.push(lines);
        totalLines += lines.length;
      }
      if (capped && paraLines.length) {
        var lastPara = paraLines[paraLines.length - 1];
        lastPara[lastPara.length - 1] += "……";
      }
      quoteH = totalLines * SHARE_LINE_H + (paraLines.length - 1) * SHARE_PARA_GAP;
    }

    // serene: the title lives on the ocean banner, not in the bottom block
    var bannerH = layout === "serene" ? 340 : 0;
    ctx.font = (layout === "serene" ? "bold 40px " : "30px ") + font.family;
    var titleLines = layout === "serene" ? [] : canvasWrapText(ctx, title, maxW, 2);
    var titleH = titleLines.length * 44;

    var headerH = layout === "quote" ? 96 :          // brand bar + site name
                  layout === "calendar" ? 150 :        // big date + weekday
                  layout === "bamboo" ? 70 :           // binding bar
                  0;                                   // plain
    var quoteTop = bannerH ? bannerH + 50 :
      layout === "plain" ? PAD + 70 :   // breathing room on top for symmetry
      PAD + headerH + (headerH ? 30 : 0);
    var titleGap = layout === "bamboo" ? 110 : 60; // bamboo: bottom rope fits in the gap
    var footH = 300;                // QR row + centered host row
    // Baseline aspect ratio: short quotes fill a uniform 3:4 card (1080x1440);
    // longer passages grow into a long image (content over ratio).
    var H_MIN = Math.round(W * 4 / 3);
    var H = Math.max(quoteTop + quoteH + titleGap + titleH + 40 + footH, H_MIN);
    // Bottom block (title + divider + QR + host) is pinned to the card bottom,
    // so short cards breathe in the middle instead of ending early.
    var divY = H - footH - 20;
    var titleTop = divY - titleH - 20;

    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext("2d");
    ctx.textBaseline = "top";

    // background
    ctx.fillStyle = bgp.bg;
    ctx.fillRect(0, 0, W, H);

    // --- header per style ---
    if (layout === "quote") {
      // brand bar + site name (top-left)
      ctx.fillStyle = style.accent;
      roundRectPath(ctx, PAD, PAD, 10, 44, 5);
      ctx.fill();
      ctx.font = "bold 34px " + font.family;
      ctx.fillStyle = bgp.text;
      ctx.fillText(siteName || "", PAD + 32, PAD + 2);
      // big opening quote mark
      ctx.font = 'bold 90px Georgia, serif';
      ctx.fillStyle = style.accent;
      ctx.fillText("\u201c", PAD - 6, quoteTop - 34);
    } else if (layout === "calendar") {
      var now = new Date();
      var wd = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
      ctx.fillStyle = style.accent;
      ctx.font = "bold 92px " + font.family;
      ctx.fillText(String(now.getDate()), PAD, PAD - 6);
      ctx.font = "bold 30px " + font.family;
      ctx.fillStyle = bgp.text;
      var dateRight = " " + now.getFullYear() + " / " + (now.getMonth() + 1);
      ctx.fillText(dateRight, PAD + 130, PAD + 14);
      ctx.font = "26px " + font.family;
      ctx.fillStyle = bgp.sub;
      ctx.fillText("星期" + wd, PAD + 130, PAD + 56);
      ctx.fillStyle = bgp.dark ? "rgba(255,255,255,0.14)" : "#e3e6ea";
      ctx.fillRect(PAD, PAD + 108, maxW, 2);
    } else if (layout === "serene") {
      // ocean banner: blue gradient + translucent wave layers, white title on top
      var grad = ctx.createLinearGradient(0, 0, 0, bannerH);
      grad.addColorStop(0, "#2a6f9e");   // dusk blue
      grad.addColorStop(0.55, "#16466b");
      grad.addColorStop(1, "#0b2a44");   // deep sea
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, bannerH);
      for (var wl = 0; wl < 3; wl++) {
        ctx.beginPath();
        var waveBase = bannerH - 70 - wl * 24;
        ctx.moveTo(0, waveBase);
        for (var wx = 0; wx <= W; wx += 8) {
          ctx.lineTo(wx, waveBase + Math.sin(wx / 95 + wl * 1.9) * (11 - wl * 2));
        }
        ctx.lineTo(W, bannerH);
        ctx.lineTo(0, bannerH);
        ctx.closePath();
        ctx.fillStyle = "rgba(255,255,255," + (0.07 + wl * 0.05) + ")";
        ctx.fill();
      }
      // white title on the banner
      ctx.font = "bold 40px " + font.family;
      ctx.fillStyle = "#ffffff";
      var bannerTitleLines = canvasWrapText(ctx, title, maxW - 60, 2);
      for (var bt = 0; bt < bannerTitleLines.length; bt++) {
        ctx.fillText(bannerTitleLines[bt], PAD, 96 + bt * 58);
      }
      // subtle host label under the title
      ctx.font = "24px " + font.family;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText("@" + window.location.hostname, PAD, 96 + bannerTitleLines.length * 58 + 18);
    } else if (layout === "bamboo") {
      // binding ropes: top edge + right after the vertical text (so the
      // footer/QR never covers the slips)
      var ropeY = titleTop - 52;
      ctx.fillStyle = style.accent;
      ctx.fillRect(PAD, PAD, maxW, 8);
      ctx.fillRect(PAD, ropeY, maxW, 8);
      for (var knot = 0; knot < 3; knot++) {
        var kx = PAD + (maxW / 4) * (knot + 1);
        ctx.beginPath();
        ctx.arc(kx, PAD + 4, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(kx, ropeY + 4, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // quote: bamboo = vertical right-to-left columns; others = horizontal
    ctx.font = quoteFont;
    ctx.fillStyle = bgp.text;
    if (layout === "bamboo") {
      var bGroupH = BAM_CHARS_PER_COL * BAM_CHAR_ADV;
      for (var gI = 0; gI < bambooGroups.length; gI++) {
        var gTop = quoteTop + gI * (bGroupH + 80);
        var gCols = bambooGroups[gI];
        for (var cI = 0; cI < gCols.length; cI++) {
          // first column starts at the RIGHT (traditional writing order)
          var colCenterX = W - PAD - 24 - cI * BAM_COL_ADV;
          var colChars = gCols[cI];
          for (var chI = 0; chI < colChars.length; chI++) {
            var chStr = colChars[chI];
            ctx.fillText(chStr, colCenterX - ctx.measureText(chStr).width / 2, gTop + chI * BAM_CHAR_ADV);
          }
        }
      }
    } else {
      var y = quoteTop;
      for (var pp = 0; pp < paraLines.length; pp++) {
        var plines = paraLines[pp];
        for (var pl = 0; pl < plines.length; pl++) {
          ctx.fillText(plines[pl], PAD, y);
          y += SHARE_LINE_H;
        }
        if (pp < paraLines.length - 1) y += SHARE_PARA_GAP; // paragraph gap
      }
    }

    // bamboo: faint slip-seam lines between vertical columns
    if (layout === "bamboo") {
      ctx.fillStyle = bgp.dark ? "rgba(255,255,255,0.10)" : "rgba(90, 70, 40, 0.14)";
      var bGroupH2 = BAM_CHARS_PER_COL * BAM_CHAR_ADV;
      for (var gS = 0; gS < bambooGroups.length; gS++) {
        var gTopS = quoteTop + gS * (bGroupH2 + 80);
        var seamCount = bambooGroups[gS].length; // seam after each column
        for (var sI = 0; sI <= seamCount; sI++) {
          var seamX = W - PAD - 24 + BAM_COL_ADV / 2 - sI * BAM_COL_ADV;
          if (seamX > PAD - 20 && seamX < W - PAD + 20) {
            ctx.fillRect(seamX, gTopS - 14, 2, bGroupH2 + 28);
          }
        }
      }
    }

    // divider
    ctx.fillStyle = bgp.dark ? "rgba(255,255,255,0.14)" : "#e3e6ea";
    ctx.fillRect(PAD, divY, maxW, 2);

    // title
    ctx.font = "30px " + font.family;
    ctx.fillStyle = bgp.sub;
    for (var t = 0; t < titleLines.length; t++) {
      ctx.fillText(titleLines[t], PAD, titleTop + t * 44);
    }

    // footer: QR right, hint left
    var qrSize = 200;
    var qrY = divY + 60;
    if (bgp.dark) {
      // white backing so the QR stays scannable on dark backgrounds
      ctx.fillStyle = "#ffffff";
      roundRectPath(ctx, W - PAD - qrSize - 12, qrY - 12, qrSize + 24, qrSize + 24, 10);
      ctx.fill();
    }
    drawQrcode(ctx, link, W - PAD - qrSize, qrY, qrSize, opts.avatar || null);

    ctx.font = "28px " + font.family;
    ctx.fillStyle = bgp.text;
    ctx.fillText("扫码查看这段原文", PAD, qrY + 44);
    ctx.font = "22px " + font.family;
    ctx.fillStyle = bgp.sub;
    ctx.fillText("长按识别二维码 · 定位到文章原位置", PAD, qrY + 92);

    // centered @host footer (from the current site, never hardcoded)
    ctx.font = "24px " + font.family;
    ctx.fillStyle = bgp.sub;
    var host = "@" + window.location.hostname;
    ctx.fillText(host, (W - ctx.measureText(host).width) / 2, qrY + qrSize + 26);

    // share timestamp, bottom-right with timezone offset (e.g. UTC+8)
    ctx.font = "20px " + font.family;
    ctx.fillStyle = bgp.sub;
    ctx.textAlign = "right";
    ctx.fillText(shareTimestamp(), W - PAD, qrY + qrSize + 30);
    ctx.textAlign = "left";

    return canvas;
  }

  function openSharePanel(section, anchor, pos, config) {
    config = config || (_inlineHost && _inlineHost._bhConfig) || window.BlogHelperConfig || {};
    var existing = document.querySelector(".bh-share-panel");
    if (existing) existing.remove();

    var link = buildPassageLink(pos);
    var title = getPostTitle();
    var siteName = document.querySelector(".site-title, .site-name") ?
      document.querySelector(".site-title, .site-name").textContent.trim() : window.location.hostname;

    var opts = loadShareOpts();

    function optRowHTML(label, map, key) {
      var html = '<div class="bh-share-opt-row"><span class="bh-share-opt-label">' + label + '</span>';
      for (var k in map) {
        if (key === "font" && k !== "serif" &&
            !shareFontAvailable(shareFontProbeName(map[k].family))) {
          continue; // device cannot render this font — hide the option entirely
        }
        html += '<button type="button" class="bh-share-opt-chip' + (opts[key] === k ? ' bh-opt-active' : '') +
          '" data-key="' + key + '" data-val="' + k + '">' + map[k].label + '</button>';
      }
      return html + '</div>';
    }

    var panel = document.createElement("div");
    panel.className = "bh-share-panel";
    panel.innerHTML =
      '<div class="bh-share-card">' +
        '<div class="bh-share-opts">' +
          optRowHTML("主题", SHARE_STYLES, "theme") +
          optRowHTML("字体", SHARE_FONTS, "font") +
          optRowHTML("背景", SHARE_BGS, "bg") +
        '</div>' +
        '<div class="bh-share-loading"><span class="bh-overlay-spinner"></span> 生成卡片中...</div>' +
        '<div class="bh-share-img-wrap" style="display:none"></div>' +
        '<div class="bh-share-actions">' +
          '<button type="button" class="bh-share-copy-link">复制链接</button>' +
          '<button type="button" class="bh-share-copy-img">复制图片</button>' +
          '<button type="button" class="bh-share-download">保存图片</button>' +
          '<button type="button" class="bh-share-native" style="display:none">分享</button>' +
          '<button type="button" class="bh-share-cancel">关闭</button>' +
        '</div>' +
        '<div class="bh-share-msg"></div>' +
      '</div>';
    document.body.appendChild(panel);

    function closePanel() {
      document.removeEventListener("keydown", onPanelKeydown);
      panel.remove();
    }
    var onPanelKeydown = function (e) { if (e.key === "Escape") closePanel(); };
    document.addEventListener("keydown", onPanelKeydown);
    panel.addEventListener("click", function (e) {
      if (e.target === panel) closePanel();
    });
    panel.querySelector(".bh-share-cancel").addEventListener("click", closePanel);
    panel.querySelector(".bh-share-copy-link").addEventListener("click", function () {
      copyToClipboard(link).then(function (ok) {
        var msg = panel.querySelector(".bh-share-msg");
        msg.style.color = ok ? "#28a745" : "#c00";
        msg.textContent = ok ? "链接已复制" : "复制失败";
        setTimeout(function () { msg.textContent = ""; }, 2000);
      });
    });

    var canvas = null;
    function renderCard() {
      // A persisted font choice may be unavailable on this device — fall back.
      if (opts.font !== "serif" && !shareFontAvailable(shareFontProbeName(SHARE_FONTS[opts.font].family))) {
        opts.font = "serif";
      }
      try {
        canvas = renderShareCard(anchor.exact, title, link, siteName, opts);
      } catch (e) {
        panel.querySelector(".bh-share-loading").innerHTML = "卡片生成失败：" + (e.message || e);
        return;
      }
      panel.querySelector(".bh-share-loading").style.display = "none";
      var wrap = panel.querySelector(".bh-share-img-wrap");
      wrap.style.display = "";
      var img = wrap.querySelector("img");
      if (!img) {
        img = document.createElement("img");
        img.alt = "分享卡片";
        wrap.appendChild(img);
      }
      img.src = canvas.toDataURL("image/png");
    }

    // option chips: switch style and re-render
    panel.querySelector(".bh-share-opts").addEventListener("click", function (e) {
      var chip = e.target && e.target.closest ? e.target.closest(".bh-share-opt-chip") : null;
      if (!chip || chip.classList.contains("bh-opt-disabled")) return;
      var key = chip.getAttribute("data-key");
      var val = chip.getAttribute("data-val");
      if (opts[key] === val) return;
      opts[key] = val;
      saveShareOpts(opts);
      var row = chip.parentNode;
      var chips = row.querySelectorAll(".bh-share-opt-chip");
      for (var i = 0; i < chips.length; i++) chips[i].classList.remove("bh-opt-active");
      chip.classList.add("bh-opt-active");
      renderCard();
    });

    loadQrcode(function () {
      loadShareAvatar(config, function (avatarImg) {
        opts.avatar = avatarImg;
        renderCard();
      });

      // copy image to clipboard
      var copyImgBtn = panel.querySelector(".bh-share-copy-img");
      if (!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem)) {
        copyImgBtn.style.display = "none";
      } else {
        copyImgBtn.addEventListener("click", function () {
          canvas.toBlob(function (blob) {
            if (!blob) return;
            var msg = panel.querySelector(".bh-share-msg");
            navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
              msg.style.color = "#28a745";
              msg.textContent = "图片已复制，可直接粘贴";
            }, function () {
              msg.style.color = "#c00";
              msg.textContent = "复制失败，请使用「保存图片」";
            });
            setTimeout(function () { msg.textContent = ""; }, 2500);
          }, "image/png");
        });
      }

      // download
      panel.querySelector(".bh-share-download").addEventListener("click", function () {
        canvas.toBlob(function (blob) {
          if (!blob) return;
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = (title || "quote").slice(0, 30).replace(/[\\/:*?"<>|]/g, "") + "-片段.png";
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        }, "image/png");
      });

      // native share (mobile): share the image file directly
      var nativeBtn = panel.querySelector(".bh-share-native");
      if (navigator.share && navigator.canShare) {
        canvas.toBlob(function (blob) {
          if (!blob) return;
          var file = new File([blob], "quote.png", { type: "image/png" });
          if (navigator.canShare({ files: [file] })) {
            nativeBtn.style.display = "";
            nativeBtn.addEventListener("click", function () {
              navigator.share({ files: [file], title: title, text: "「" + anchor.exact.slice(0, 50) + "」" }).catch(function () {});
            });
          }
        }, "image/png");
      }
    });
  }

  // Deep link: #bh-{start}-{end} positions to a passage. If the passage has
  // comments, the painted highlight carries that id; otherwise a temporary
  // highlight is painted from the offsets. Used by copied links and share-card
  // QR codes.
  function handleDeepLink(section) {
    if (section._bhDeepLinked) return;
    var m = /^#bh-(\d+)-(\d+)$/.exec(window.location.hash);
    if (!m) return;
    var start = parseInt(m[1], 10);
    var end = parseInt(m[2], 10);
    var el = document.getElementById("bh-" + start + "-" + end);
    if (!el) {
      var inline = section._bhInline;
      if (!inline || !inline.content) return;
      var r = rangeFromOffsets(inline.content, start, end);
      if (!r) return;
      var marks = wrapRangeMarks(r);
      if (!marks.length) return;
      marks[0].id = "bh-" + start + "-" + end;
      el = marks[0];
    }
    section._bhDeepLinked = true;
    // Expand collapsed ancestors (<details>) so the passage becomes visible
    for (var anc = el.parentElement; anc; anc = anc.parentElement) {
      if (anc.tagName === "DETAILS" && !anc.open) anc.open = true;
    }
    setTimeout(function () {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("bh-hl-flash");
      void el.offsetWidth;
      el.classList.add("bh-hl-flash");
      setTimeout(function () { el.classList.remove("bh-hl-flash"); }, 3000);
    }, 300);
  }

  // --- Anchor popover ---

  function closeAnchorPopover(section) {
    var pop = section._bhPop;
    if (!pop) return;
    // Return the (possibly moved) comment form to the comment section
    var form = section._bhFormEl;
    if (form && pop.contains(form)) {
      var trigger = section.querySelector(".bh-comment-form-trigger");
      section.insertBefore(form, trigger ? trigger.nextSibling : null);
      form.style.display = "none";
    }
    if (pop._bhCleanup) {
      for (var i = 0; i < pop._bhCleanup.length; i++) pop._bhCleanup[i]();
    }
    if (pop.parentNode) pop.parentNode.removeChild(pop);
    section._bhPop = null;
    removePendingMarks(section);
    // Clear any pending inline anchor so the bottom form doesn't inherit it
    if (section._bhState) {
      section._bhState.anchor = null;
      section._bhState.replyTo = null;
    }
  }

  // Paint a dashed "pending" underline on a passage whose comment form is open
  // (instant feedback before the comment is submitted).
  function paintPendingMarks(section, pos) {
    removePendingMarks(section);
    var inline = section._bhInline;
    if (!inline || !inline.content || !pos) return;
    var r = rangeFromOffsets(inline.content, pos.start, pos.end);
    if (!r) return;
    var marks = wrapRangeMarks(r);
    for (var i = 0; i < marks.length; i++) {
      marks[i].classList.add("bh-hl-pending");
      marks[i].id = "bh-p-" + pos.start + "-" + pos.end;
    }
    section._bhPendingMarks = marks;
  }

  function removePendingMarks(section) {
    var marks = section._bhPendingMarks;
    if (!marks) return;
    section._bhPendingMarks = null;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    }
    if (section._bhInline && section._bhInline.content) section._bhInline.content.normalize();
  }

  function openAnchorPopover(section, state, config, slug, info) {
    closeAnchorPopover(section);
    var inline = section._bhInline;
    if (!inline || !inline.content) return;
    var container = inline.content;
    var anchor = info.anchor;
    var pos = info.pos || (anchor ? resolveAnchor(anchor, container) : null);
    if (!anchor) return;

    var pop = document.createElement("div");
    pop.className = "bh-anchor-popover";
    pop.innerHTML =
      '<div class="bh-anchor-popover-inner">' +
        '<button class="bh-anchor-close" type="button" title="关闭">✕</button>' +
        '<div class="bh-anchor-comments"></div>' +
        '<div class="bh-anchor-actions">' +
          '<button class="bh-anchor-share" type="button" title="生成分享卡片">📤 转发</button>' +
          '<button class="bh-anchor-write" type="button">💬 评论这段</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(pop);
    section._bhPop = pop;

    function rectFn() {
      if (info.mark && info.mark.parentNode) return info.mark.getBoundingClientRect();
      if (pos) {
        var r = rangeFromOffsets(container, pos.start, pos.end);
        if (r) return r.getBoundingClientRect();
      }
      return { left: window.innerWidth / 2 - 160, top: window.innerHeight / 3, width: 0, bottom: window.innerHeight / 3 };
    }

    function position() {
      var rect = rectFn();
      pop.style.visibility = "hidden";
      pop.style.display = "";
      var pw = pop.offsetWidth, ph = pop.offsetHeight;
      // Prefer below the passage, left-aligned to its start
      var left = rect.left;
      if (left + pw > window.innerWidth - 8) left = Math.max(8, rect.right - pw);
      var top = rect.bottom + 10;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 10);
      pop.style.left = left + "px";
      pop.style.top = top + "px";
      pop.style.visibility = "";
    }

    function commentsAt() {
      var res = [];
      // Opened from an existing highlight: match by the mark's comment ids
      // (covers comments merged in from overlapping passages). Read them live
      // from the DOM so freshly posted comments appear without reopening.
      var cids = info.cids;
      if (info.markId) {
        var liveMark = document.getElementById(info.markId);
        if (liveMark) cids = (liveMark.getAttribute("data-cids") || "").split(",");
      }
      if (cids) {
        for (var i = 0; i < state.comments.length; i++) {
          if (cids.indexOf(String(state.comments[i].id)) !== -1) res.push(state.comments[i]);
        }
        return res;
      }
      if (!pos) return res;
      for (var j = 0; j < state.comments.length; j++) {
        var c = state.comments[j];
        if (!c.anchor) continue;
        var a = parseAnchor(c.anchor);
        if (!a) continue;
        var p = resolveAnchor(a, container);
        if (p && p.start === pos.start && p.end === pos.end) res.push(c);
      }
      return res;
    }

    function refreshComments() {
      var box = pop.querySelector(".bh-anchor-comments");
      var list = commentsAt();
      if (!list.length) {
        box.innerHTML = '<div class="bh-no-comments" style="text-align:left;padding:4px 0">还没有这段的评论</div>';
        return;
      }
      var commentMap = state._commentMap || {};
      var html = "";
      for (var i = 0; i < list.length; i++) html += renderCommentItem(list[i], commentMap, false);
      box.innerHTML = html;
      var btns = box.querySelectorAll(".bh-reply-btn");
      for (var b = 0; b < btns.length; b++) {
        btns[b].addEventListener("click", function () {
          var id = parseInt(this.getAttribute("data-id"));
          state.replyTo = commentMap[id] || null;
          state.anchor = anchor; // replies inherit the passage anchor
          showPopoverForm();
        });
      }
      var ebtns = box.querySelectorAll(".bh-edit-btn");
      for (var eb = 0; eb < ebtns.length; eb++) {
        ebtns[eb].addEventListener("click", function () {
          var id = parseInt(this.getAttribute("data-id"));
          startCommentEdit(section, state, config, id, box);
        });
      }
      // reactions work inside the popover too
      bindReactionButtons(box, state, config, commentMap);
      // avatar / author name cards inside the popover
      bindCommenterCards(box, state, commentMap);
    }

    function showPopoverForm() {
      var form = section._bhFormEl;
      if (!form) return;
      if (!pop.contains(form)) {
        var actions = pop.querySelector(".bh-anchor-actions");
        pop.querySelector(".bh-anchor-popover-inner").insertBefore(form, actions.nextSibling);
      }
      pop.querySelector(".bh-anchor-popover-inner").classList.add("bh-form-open");
      paintPendingMarks(section, pos);
      form.style.display = "";
      renderCommentForm(section, state, config, slug, form);
      position();
      var ta = form.querySelector("textarea");
      if (ta) ta.focus();
    }

    pop._bhOnPosted = function (newComment) {
      removePendingMarks(section);
      refreshComments();
      if (section._bhRefreshInline) section._bhRefreshInline();
      var form = section._bhFormEl;
      if (form) form.style.display = "none";
      if (newComment && newComment.status === "pending") {
        var box = pop.querySelector(".bh-anchor-comments");
        var notice = document.createElement("div");
        notice.className = "bh-pending-notice";
        notice.textContent = "评论已提交，等待审核后展示";
        box.insertBefore(notice, box.firstChild);
        setTimeout(function () { if (notice.parentNode) notice.parentNode.removeChild(notice); }, 5000);
      }
      position();
    };

    pop.querySelector(".bh-anchor-close").addEventListener("click", function () {
      closeAnchorPopover(section);
    });
    pop.querySelector(".bh-anchor-write").addEventListener("click", function () {
      state.replyTo = null;
      state.anchor = anchor;
      showPopoverForm();
    });
    pop.querySelector(".bh-anchor-share").addEventListener("click", function () {
      closeAnchorPopover(section);
      openSharePanel(section, anchor, pos, config);
    });
    refreshComments();
    position();

    // No comments on this passage yet: open the form directly (one click less)
    if (commentsAt().length === 0) {
      state.anchor = anchor;
      showPopoverForm();
    }

    // Reposition on scroll/resize; close on Escape or outside click.
    var onScroll = throttle(function () { position(); }, 100);
    var onKeydown = function (e) { if (e.key === "Escape") closeAnchorPopover(section); };
    var onDocMousedown = function (e) {
      if (!pop.contains(e.target) && !(section._bhBubble && section._bhBubble.contains(e.target))) {
        closeAnchorPopover(section);
      }
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("mousedown", onDocMousedown, true);
    pop._bhCleanup = [
      function () { window.removeEventListener("scroll", onScroll, true); },
      function () { window.removeEventListener("resize", onScroll); },
      function () { document.removeEventListener("keydown", onKeydown); },
      function () { document.removeEventListener("mousedown", onDocMousedown, true); },
    ];
  }

  function openAnchorPopoverByMark(mark, section, state, config, slug) {
    var cids = (mark.getAttribute("data-cids") || "").split(",");
    var first = null;
    for (var i = 0; i < state.comments.length; i++) {
      if (String(state.comments[i].id) === cids[0]) { first = state.comments[i]; break; }
    }
    if (!first) return;
    var a = parseAnchor(first.anchor);
    if (!a) return;
    openAnchorPopover(section, state, config, slug, {
      anchor: a,
      pos: resolveAnchor(a, section._bhInline.content),
      cids: cids,
      mark: mark,
      markId: mark.id,
    });
  }

  // --- Selection bubble (multi-action menu: comment / copy / share) ---

  function getPostTitle() {
    var h1 = document.querySelector("h1");
    return (h1 && h1.textContent.trim()) || document.title || "";
  }

  function buildPassageLink(pos) {
    var clean = window.location.href.split("#")[0];
    if (!pos) return clean;
    return clean + "#bh-" + pos.start + "-" + pos.end;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function bhToast(msg) {
    var t = document.querySelector(".bh-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "bh-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("bh-toast-show");
    clearTimeout(t._bhTimer);
    t._bhTimer = setTimeout(function () { t.classList.remove("bh-toast-show"); }, 2000);
  }

  function copyPassage(anchor, pos) {
    var text = "「" + anchor.exact + "」\n—— " + getPostTitle() + "\n" + buildPassageLink(pos);
    copyToClipboard(text).then(function (ok) {
      bhToast(ok ? "已复制引用和链接" : "复制失败，请手动复制");
    });
  }

  function initSelectionBubble(section, state, config, slug, container) {
    var bubble = document.createElement("div");
    bubble.className = "bh-select-bubble";
    bubble.innerHTML =
      '<button type="button" data-act="comment" title="评论这段" style="display:none">评论</button>' +
      '<button type="button" data-act="copy" title="复制引用和链接">复制</button>' +
      '<button type="button" data-act="share" title="生成分享卡片">转发</button>';
    bubble.style.display = "none";
    document.body.appendChild(bubble);
    section._bhBubble = bubble;

    // The comment action only appears once the comment section is live
    // (host._bhFormEl is set by renderCommentSection). Copy/share always work.
    function syncCommentAction() {
      var btn = bubble.querySelector('button[data-act="comment"]');
      if (!btn) return;
      var can = !!(section._bhFormEl || (_inlineHost && _inlineHost._bhFormEl));
      btn.style.display = can ? "" : "none";
    }

    var pending = null; // {range, anchor}
    var _viaMouse = false; // true while the menu was opened via mouseup

    function hide() {
      bubble.style.display = "none";
      pending = null;
      _viaMouse = false;
    }

    document.addEventListener("mouseup", function (e) {
      if (bubble.contains(e.target)) return;
      var mx = e.clientX, my = e.clientY;
      setTimeout(function () {
        var valid = validateSelection();
        if (!valid) return hide();
        pending = valid;
        _viaMouse = true; // selectionchange must not override mouse positioning
        // Follow the mouse position (where the user finished the selection)
        showAt(mx, my + 12);
      }, 10);
    });

    // Keep the selection alive when clicking the bubble
    bubble.addEventListener("mousedown", function (e) { e.preventDefault(); });
    function handleBubbleAction(target) {
      var btn = target && target.closest ? target.closest("button[data-act]") : null;
      if (!btn || !pending) return;
      var act = btn.getAttribute("data-act");
      var pos = resolveAnchor(pending.anchor, container);
      // Always act on the CURRENT host: the comment section registers itself
      // onto _inlineHost after this bubble was created (initially a detached
      // host with a null state), so the closed-over section/state are stale.
      var host = _inlineHost || section;
      if (act === "comment") {
        if (!host._bhFormEl) return;
        var info = { anchor: pending.anchor };
        if (pos) info.pos = pos;
        hide();
        var sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        openAnchorPopover(host, host._bhState, host._bhConfig, host._bhSlug, info);
      } else if (act === "copy") {
        copyPassage(pending.anchor, pos);
        hide();
        var sel2 = window.getSelection();
        if (sel2) sel2.removeAllRanges();
      } else if (act === "share") {
        var anchor = pending.anchor;
        hide();
        var sel3 = window.getSelection();
        if (sel3) sel3.removeAllRanges();
        openSharePanel(host, anchor, pos, host._bhConfig || config);
      }
    }

    // Shared validation of the current selection (used by mouse and touch paths)
    function validateSelection() {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      var text = sel.toString();
      if (!text || text.trim().length < 2 || text.length > 1000) return null;
      var range = sel.getRangeAt(0);
      var node = range.commonAncestorContainer;
      var el = node.nodeType === 3 ? node.parentNode : node;
      if (!container.contains(el)) return null;
      if (el.closest && el.closest("span.bh-hl")) return null;
      if (el.closest && el.closest(".bh-comments, .bh-anchor-popover, .bh-select-bubble, .bh-page-reactions, .bh-share-panel")) return null;
      var anchor = buildAnchor(range, container);
      if (!anchor) return null;
      return { range: range, anchor: anchor };
    }

    function showAt(left, top) {
      syncCommentAction();
      bubble.style.display = "";
      var bw = bubble.offsetWidth, bh = bubble.offsetHeight;
      left = Math.max(8, Math.min(left - bw / 2, window.innerWidth - bw - 8));
      bubble.style.left = left + "px";
      bubble.style.top = Math.max(8, top - bh - 12) + "px";
    }

    // Touch path: iOS/Android selection handles never fire mouseup — drive the
    // menu from selectionchange with a debounce so it appears once the user
    // finishes dragging the handles. Positioned above the selection rect.
    var touchTimer = null;
    document.addEventListener("selectionchange", function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) { hide(); return; }
      if (_viaMouse) return; // desktop mouseup path owns the positioning
      clearTimeout(touchTimer);
      touchTimer = setTimeout(function () {
        var valid = validateSelection();
        if (!valid) return;
        pending = valid;
        var rect = valid.range.getBoundingClientRect();
        showAt(rect.left + rect.width / 2, rect.top);
      }, 350);
    });

    bubble.addEventListener("click", function (e) { handleBubbleAction(e.target); });

    // Keep the selection alive when tapping menu buttons on touch devices:
    // preventDefault on touchstart stops iOS from clearing the selection, and
    // handling the action on touchend (preventDefault) stops the synthetic
    // click from double-firing.
    bubble.addEventListener("touchstart", function (e) { e.preventDefault(); }, { passive: false });
    bubble.addEventListener("touchend", function (e) {
      e.preventDefault();
      handleBubbleAction(e.target);
    }, { passive: false });
  }

  // Module-level inline-comments host. The comment section element is the
  // host when comments are enabled; otherwise a detached div acts as the host
  // so copy/share still work on pages without blog-helper comments (e.g.
  // pages using giscus for comments).
  var _inlineHost = null;
  var _inlineInited = false;

  function initInlineComments(section, state, config, slug) {
    if (config.features.showInlineComments === false) return;
    var container = document.querySelector(config.selectors.postContainer);
    if (!container) return;

    // Anchor into the prose content, not the whole post container: containers
    // often hold async-rendered dynamic text (view counters, reaction bars)
    // that shifts character offsets. Prefer the dedicated content element
    // (MWaterBook/ThinkBook: .post-content), then the article element
    // (md2site/ai-notes: .container > article), else the container itself.
    var contentEl = container.querySelector(".post-content, .markdown-body") ||
                    container.querySelector("article") ||
                    container;

    if (!_inlineInited) {
      _inlineInited = true;
      _inlineHost = section || document.createElement("div"); // detached host when no comments
      _inlineHost._bhInline = { container: container, content: contentEl };
      _inlineHost._bhRefreshInline = function () {
        renderInlineHighlights(_inlineHost, _inlineHost._bhState || { comments: [] });
      };

      // Clicking a highlight opens the popover (only comment-backed highlights
      // carry data-cids, so this never fires on comment-less pages)
      if (!container._bhHlBound) {
        container._bhHlBound = true;
        container.addEventListener("click", function (e) {
          var hl = e.target && e.target.closest ? e.target.closest("span.bh-hl") : null;
          if (!hl) return;
          var sel = window.getSelection();
          if (sel && !sel.isCollapsed) return; // user is selecting text
          e.preventDefault();
          e.stopPropagation();
          var host = _inlineHost;
          if (host && host._bhFormEl) {
            openAnchorPopoverByMark(hl, host, host._bhState, host._bhConfig, host._bhSlug);
          }
        });
      }

      initSelectionBubble(_inlineHost, state, config, slug, contentEl);

      // Deep-link fallback: try positioning once after init (also re-run
      // after comment loads and on every highlight refresh).
      setTimeout(function () { handleDeepLink(_inlineHost); }, 600);
    }

    // (Re-)register the comment section when it comes up — this is what
    // enables the "评论" action in the selection menu.
    if (section && _inlineHost !== section) {
      // migrate module state from the detached host onto the real section
      var prev = _inlineHost;
      section._bhInline = prev._bhInline || { container: container, content: contentEl };
      section._bhRefreshInline = prev._bhRefreshInline;
      section._bhBubble = prev._bhBubble;
      section._bhDeepLinked = prev._bhDeepLinked;
      section._bhPop = prev._bhPop;
      section._bhPendingMarks = prev._bhPendingMarks;
      _inlineHost = section;
    }
    _inlineHost._bhState = state || _inlineHost._bhState || { comments: [] };
    _inlineHost._bhConfig = config;
    _inlineHost._bhSlug = slug;
    container._bhSection = _inlineHost;
  }

  // Inline comments are independent of the comment section: pages without
  // blog-helper comments still get the selection menu (copy / share) and
  // deep links.
  function initInlineCommentsStandalone(config, slug) {
    initInlineComments(null, null, config, slug);
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

    // List page: showListAll (UV + PV + likes) takes priority over showListPV
    if (pageType === "list" && config.features.showListAll) {
      var items = document.querySelectorAll(config.selectors.listItems);
      var slugs = [];

      for (var i = 0; i < items.length; i++) {
        var link = items[i].querySelector(config.selectors.listItemLink);
        if (link && link.href) {
          try {
            slugs.push(normalizeSlug(new URL(link.href).pathname));
          } catch (e) {
            continue;
          }
        }
      }

      if (slugs.length > 0) {
        promises.push(
          Promise.all([
            apiBatchStats(config, slugs),
            apiPageReactionsBatch(config, slugs),
          ]).then(function (results) {
            renderListAll(config, results[0], results[1]);
          })
        );
      }
    } else if (pageType === "list" && config.features.showListPV) {
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
        cachedPopular(config).then(function (articles) {
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
      // Inline comments run independently of the comment section: pages
      // without blog-helper comments (e.g. giscus) still get copy/share.
      if (config.features.showInlineComments !== false) {
        initInlineCommentsStandalone(config, commentSlug);
      }
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
