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
    },
    pvLabel: "阅读",
    uvLabel: "观众",
    separator: " | ",
    popularTitle: "Hot Posts",
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
    path = path.toLowerCase();
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

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ============================================================
  // 6. Main / Init
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

    // Post page: report PV + show stats
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
