package handler

import (
	"net/http"
	"strings"
)

// dashboardHTML is the self-contained analytics dashboard page.
// All CSS and JS are inline — zero external dependencies.
// IMPORTANT: Go raw string literal — must NOT contain backtick characters.
const dashboardHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blog Analytics</title>
<style>
:root{
  --bg:#f5f6f8;--card:#fff;--text:#1d1d1f;--muted:#86868b;--border:#e5e5e7;
  --accent:#0071e3;--accent2:#34c759;--accent-bg:rgba(0,113,227,0.07);
  --error:#ff3b30;--bar-bg:#f2f2f7;--hover:#f9f9fb;
  --shadow:0 0.5px 1px rgba(0,0,0,0.04),0 1px 3px rgba(0,0,0,0.08);
  --radius:10px;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#000;--card:#1c1c1e;--text:#f5f5f7;--muted:#86868b;--border:#38383a;
  --accent:#0a84ff;--accent2:#30d158;--accent-bg:rgba(10,132,255,0.12);
  --error:#ff453a;--bar-bg:#2c2c2e;--hover:#2c2c2e;
  --shadow:0 0.5px 1px rgba(0,0,0,0.2),0 1px 3px rgba(0,0,0,0.3);
}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased}

/* ── Header ── */
.hdr{background:var(--card);border-bottom:1px solid var(--border);padding:10px 20px;
  display:flex;align-items:center;gap:16px;flex-wrap:wrap;position:sticky;top:0;z-index:10}
.hdr h1{font-size:15px;font-weight:600;white-space:nowrap;letter-spacing:-0.01em}
.hdr-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.inp{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;
  color:var(--text);font-size:12px;outline:none;transition:border-color 0.2s}
.inp:focus{border-color:var(--accent)}
.inp-s{width:140px}.inp-f{width:180px}
.tag{display:inline-flex;align-items:center;background:var(--accent-bg);color:var(--accent);
  padding:2px 8px;border-radius:4px;font-size:11px;gap:4px}
.tag-x{cursor:pointer;font-weight:700;opacity:0.6}.tag-x:hover{opacity:1}
.btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;border:none;
  border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;transition:all 0.15s;white-space:nowrap;font-weight:500}
.btn:hover{filter:brightness(1.1)}
.btn-s{padding:5px 14px;font-size:12px;border-radius:5px}
.btn-g{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn-g.on,.btn-g:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}
.ts{color:var(--muted);font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}

/* ── Layout ── */
.dash{max-width:1360px;margin:0 auto;padding:16px 20px}
.row{display:grid;gap:14px;margin-bottom:14px}
.row-stats{grid-template-columns:1fr 1fr 1fr 1fr}
.row-chart{grid-template-columns:1fr}
.row-mid{grid-template-columns:1fr 1fr}
.row-mid3{grid-template-columns:1fr 280px 1fr}
.row-data{grid-template-columns:1fr}

/* ── Cards ── */
.c{background:var(--card);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);
  border:1px solid var(--border);transition:box-shadow 0.2s;overflow:hidden}
.c:hover{box-shadow:0 1px 4px rgba(0,0,0,0.1)}
.c-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:6px}
.c-t{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted)}
.tabs{display:flex;gap:3px}

/* ── Stat cards ── */
.c-stat{min-height:0;padding:12px 16px}
.c-stat .c-h{margin-bottom:6px}
.stat-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.stat-v{font-size:26px;font-weight:700;line-height:1.15;letter-spacing:-0.02em}
.stat-l{color:var(--muted);font-size:11px}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent2);
  margin-right:4px;vertical-align:middle;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

/* ── Chart ── */
.chart-w{width:100%;overflow:hidden;height:160px}
.chart-w svg{display:block;width:100%;height:100%}
.trend-legend{font-size:11px;color:var(--muted);white-space:nowrap}
.trend-legend b{font-weight:600}
.trend-legend .tl-pv{color:var(--accent)}
.trend-legend .tl-uv{color:var(--accent2)}

/* ── Lists ── */
.ls{max-height:400px;overflow-y:auto;min-height:120px}
.lr{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:6px;font-size:13px;
  transition:background 0.15s;cursor:default}
.lr:hover{background:var(--hover)}
.lr+.lr{border-top:1px solid var(--border)}
.lr-f{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lr-f a{color:var(--text);text-decoration:none}.lr-f a:hover{color:var(--accent)}
.lr-n{color:var(--muted);font-size:11px;flex-shrink:0;min-width:36px;text-align:right}
.lr-r{color:var(--muted);font-size:10px;flex-shrink:0;width:18px;text-align:center}
.lr-bar{flex-shrink:0;width:50px;height:3px;background:var(--bar-bg);border-radius:2px;overflow:hidden}
.lr-bar-f{height:100%;background:var(--accent);border-radius:2px;transition:width 0.3s}
.lr-sub{color:var(--muted);font-size:11px;flex-shrink:0;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lr-time{color:var(--muted);font-size:11px;flex-shrink:0}

/* ── Table ── */
.tbl-w{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px;line-height:1.5}
.tbl th{text-align:left;font-weight:600;color:var(--muted);padding:8px 10px;
  border-bottom:2px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:0.04em;
  position:sticky;top:0;background:var(--card);white-space:nowrap}
.tbl td{padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:var(--hover)}
.tbl a{color:var(--accent);text-decoration:none;font-weight:500}.tbl a:hover{text-decoration:underline;color:var(--accent)}
.tbl .td-time{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.tbl .td-ip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted)}
.tbl .td-ua{font-size:11px;color:var(--muted)}
.tbl .td-fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.tbl .td-ref{font-size:11px}
.pgr{display:flex;align-items:center;justify-content:space-between;margin-top:8px;
  padding-top:8px;border-top:1px solid var(--border);font-size:11px;color:var(--muted)}
.pgr-btns{display:flex;gap:4px}

/* ── Tab panel ── */
.tp{display:none}.tp.on{display:block}
.tp-tabs{display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:12px}
.tp-tab{padding:6px 14px;font-size:12px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;
  margin-bottom:-2px;transition:all 0.15s;font-weight:500;background:none;border-top:none;border-left:none;border-right:none}
.tp-tab:hover{color:var(--text)}
.tp-tab.on{color:var(--accent);border-bottom-color:var(--accent)}
.tp-hint{font-size:11px;color:var(--muted);margin-left:auto;align-self:center}

/* ── Platform bars ── */
.plat-row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px}
.plat-row+.plat-row{border-top:1px solid var(--border)}
.plat-icon{width:18px;text-align:center;font-size:14px;flex-shrink:0}
.plat-name{width:60px;color:var(--text);font-weight:500;flex-shrink:0}
.plat-bar{flex:1;height:6px;background:var(--bar-bg);border-radius:3px;overflow:hidden}
.plat-bar-f{height:100%;border-radius:3px;transition:width 0.4s}
.plat-pct{width:36px;text-align:right;color:var(--muted);font-size:11px;flex-shrink:0}
.plat-cnt{width:36px;text-align:right;color:var(--muted);font-size:11px;flex-shrink:0}

/* ── States ── */
.ld{color:var(--muted);font-size:12px;padding:20px 0;text-align:center}
.err{color:var(--error);font-size:12px;padding:12px 0}
.emp{color:var(--muted);font-size:12px;font-style:italic;padding:12px 0}

/* ── Tooltip ── */
.tip{position:fixed;background:var(--card);border:1px solid var(--border);border-radius:8px;
  padding:8px 12px;font-size:11px;box-shadow:0 4px 12px rgba(0,0,0,0.15);pointer-events:none;z-index:999;
  white-space:nowrap;display:none;line-height:1.6}

/* ── Footer ── */
.footer{text-align:center;padding:32px 20px 48px;color:var(--muted);font-size:11px}
.footer a{color:var(--muted);text-decoration:none}.footer a:hover{color:var(--accent)}

/* ── Responsive ── */
@media(max-width:900px){.row-stats{grid-template-columns:1fr 1fr}.row-mid{grid-template-columns:1fr}.row-mid3{grid-template-columns:1fr}}
@media(max-width:600px){.hdr{padding:8px 14px}.dash{padding:12px}.row-stats{grid-template-columns:1fr 1fr}
  .inp-s{width:100px}.inp-f{width:130px}}
</style>
</head>
<body>
<div class="hdr">
  <h1>Blog Analytics <span style="font-size:11px;font-weight:400;color:var(--muted)">@ {{VERSION}}</span></h1>
  <span class="ts" id="ts" style="margin-left:2px"></span>
  <div class="hdr-r">
    <input type="text" id="i-site" class="inp inp-s" placeholder="site_id" title="Site ID">
    <input type="text" id="i-slug" class="inp inp-f" placeholder="Filter article..." title="Filter by slug or title">
    <span id="slug-tag"></span>
    <button class="btn" onclick="loadAll()">Refresh</button>
    <select id="auto-ref" class="inp" style="width:auto;padding:4px 6px" onchange="setAutoRef(this.value)" title="Auto-refresh interval">
      <option value="0">Auto: Off</option>
      <option value="10">10s</option>
      <option value="30">30s</option>
      <option value="60">1min</option>
      <option value="300">5min</option>
      <option value="3600">1h</option>
    </select>
  </div>
</div>

<div class="dash">
  <!-- Row 1: Stats overview (4 compact cards) -->
  <div class="row row-stats">
    <div class="c c-stat" id="c-active"><div class="c-h"><span class="c-t">Active Visitors</span></div><div id="d-active" class="ld">-</div></div>
    <div class="c c-stat" id="c-totalpv"><div class="c-h"><span class="c-t" id="lbl-pv">Total PV</span></div><div id="d-totalpv" class="ld">-</div></div>
    <div class="c c-stat" id="c-totaluv"><div class="c-h"><span class="c-t" id="lbl-uv" title="UV = COUNT(DISTINCT fingerprint). Visitors without fingerprint are counted as 1.">Total UV</span></div><div id="d-totaluv" class="ld">-</div></div>
    <div class="c c-stat" id="c-health"><div class="c-h"><span class="c-t">Uptime</span></div><div id="d-health" class="ld">-</div></div>
  </div>

  <!-- Row 2: Trend chart (full width) -->
  <div class="row row-chart">
    <div class="c">
      <div class="c-h">
        <span class="c-t" id="trend-label">PV / UV Trend</span>
        <span class="trend-legend" id="trend-leg"></span>
        <div class="tabs" id="trend-tabs"></div>
      </div>
      <div class="chart-w" id="d-trend"><div class="ld">Loading...</div></div>
    </div>
  </div>

  <!-- Row 3: Referrers + UA + Popular -->
  <div class="row row-mid3">
    <div class="c">
      <div class="c-h"><span class="c-t">Top Referrers</span></div>
      <div class="ls" id="d-ref"><div class="ld">Loading...</div></div>
    </div>
    <div class="c">
      <div class="c-h"><span class="c-t" id="lbl-plat">Platforms</span></div>
      <div id="d-plat"><div class="ld">Loading...</div></div>
    </div>
    <div class="c">
      <div class="c-h">
        <span class="c-t">Popular Articles</span>
        <div class="tabs" id="pop-tabs"></div>
      </div>
      <div class="ls" id="d-pop"><div class="ld">Loading...</div></div>
    </div>
  </div>

  <!-- Row 4: Visitors + Views (tabbed) -->
  <div class="row row-data">
    <div class="c">
      <div class="tp-tabs">
        <button class="tp-tab" id="tab-vis" onclick="switchTab('vis')">Visitors</button>
        <button class="tp-tab on" id="tab-views" onclick="switchTab('views')">Raw Views</button>
        <span class="tp-hint" id="data-hint"></span>
      </div>
      <div class="tp" id="p-vis"><div id="d-vis"><div class="ld">Loading...</div></div></div>
      <div class="tp on" id="p-views"><div id="d-views"><div class="ld">Loading...</div></div></div>
    </div>
  </div>
</div>

<div class="footer">Powered by <a href="https://github.com/thinkycx/blog-helper">blog-helper</a></div>

<div class="tip" id="tip"></div>

<script>
(function(){
  "use strict";

  // ── State ──
  var _p = new URLSearchParams(window.location.search);
  var S = {
    site: _p.get("site_id") || window.location.hostname,
    slug: _p.get("slug") || "", fp: "",
    period: _p.get("period") || "7d", popN: 10,
    vOff: 0, vLim: 30,
    rOff: 0, rLim: 20,
    tab: "views"
  };

  var elSite = document.getElementById("i-site");
  var elSlug = document.getElementById("i-slug");
  elSite.value = S.site;
  if(S.slug) elSlug.value = S.slug;

  elSlug.addEventListener("keydown", function(e){
    if(e.key === "Enter"){ S.slug = elSlug.value.trim(); S.fp = ""; S.vOff = 0; refresh(); }
  });
  elSite.addEventListener("keydown", function(e){
    if(e.key === "Enter") loadAll();
  });

  function $(id){ return document.getElementById(id); }
  function h(s){ var d=document.createElement("div"); d.appendChild(document.createTextNode(s||"")); return d.innerHTML; }
  function cut(s,n){ return s && s.length>n ? s.slice(0,n)+"..." : (s||""); }
  function num(n){ return (n||0).toLocaleString(); }
  function pad2(n){ return n<10?"0"+n:""+n; }

  // UTC → local timezone
  function toLocal(s){
    if(!s||s.length<=10) return s||"";
    var iso=s.replace(" ","T"); if(iso.indexOf("Z")<0&&iso.indexOf("+")<0) iso+="Z";
    var d=new Date(iso); if(isNaN(d)) return s;
    return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate())+" "+pad2(d.getHours())+":"+pad2(d.getMinutes())+":"+pad2(d.getSeconds());
  }
  function localHM(s){
    var d=new Date(s.replace(" ","T")+"Z"); if(isNaN(d)) return s.slice(11);
    return pad2(d.getHours())+":"+pad2(d.getMinutes());
  }
  function localTip(s){
    if(!s||s.length<=10) return s||"";
    var d=new Date(s.replace(" ","T")+"Z"); if(isNaN(d)) return s;
    return pad2(d.getMonth()+1)+"-"+pad2(d.getDate())+" "+pad2(d.getHours())+":"+pad2(d.getMinutes());
  }

  // API + cache (switching tabs/periods uses cache; Refresh clears it)
  var _cache={};
  function api(p,retry){ return fetch("/api/v1/"+p).then(function(r){return r.json();}).then(function(j){
    if(j.ok) return j.data; throw new Error(j.error?j.error.message:"Error");
  }).catch(function(e){
    if(!retry) return api(p,true); // one retry on transient failure
    throw e;
  }); }
  function capi(p){
    if(_cache[p]!==undefined) return Promise.resolve(_cache[p]);
    return api(p).then(function(d){ _cache[p]=d; return d; });
  }

  function qs(o){ var p=[]; for(var k in o){if(o[k]!==undefined&&o[k]!=="")p.push(k+"="+encodeURIComponent(o[k]));} return p.join("&"); }
  function pLabel(p){var m={"1h":"1h","6h":"6h","1d":"24h","7d":"7d","30d":"30d","90d":"90d","180d":"180d","365d":"1y"};return m[p]||p;}
  function pDays(p){if(p==="1h"||p==="6h"||p==="1d")return 1;var m=p.match(/^(\d+)d$/);return m?parseInt(m[1]):30;}
  function pPopPeriod(p){if(p==="1h"||p==="6h"||p==="1d")return "7d";return p==="365d"?"all":p;}

  // ── URL sync ──
  function syncURL(){
    var u=new URL(window.location);
    u.searchParams.set("site_id",S.site);
    if(S.period&&S.period!=="7d") u.searchParams.set("period",S.period); else u.searchParams.delete("period");
    if(S.slug) u.searchParams.set("slug",S.slug); else u.searchParams.delete("slug");
    history.replaceState(null,"",u.toString());
  }

  // ── Slug tag ──
  function syncTag(){
    var el=$("slug-tag");
    if(S.slug) el.innerHTML='<span class="tag">'+h(S.slug)+' <span class="tag-x" onclick="clrSlug()">x</span></span>';
    else el.innerHTML="";
  }
  window.clrSlug=function(){ S.slug=""; S.fp=""; elSlug.value=""; S.vOff=0; _cache={}; syncURL(); refresh(); };
  window.drillSlug=function(s){ S.slug=s; S.fp=""; elSlug.value=s; S.vOff=0; _cache={}; syncURL(); refresh(); };
  window.viewFp=function(fp){ S.fp=fp; S.rOff=0; switchTab("vis"); loadVis(); };
  window.backVis=function(){ S.fp=""; S.rOff=0; loadVis(); };

  // ── Tabs (data panel) ──
  window.switchTab=function(t){
    S.tab=t;
    $("tab-vis").className="tp-tab"+(t==="vis"?" on":"");
    $("tab-views").className="tp-tab"+(t==="views"?" on":"");
    $("p-vis").className="tp"+(t==="vis"?" on":"");
    $("p-views").className="tp"+(t==="views"?" on":"");
  };

  // ── Button group builder ──
  function tabs(id,opts,cur,fn){
    var el=$(id); el.innerHTML="";
    for(var i=0;i<opts.length;i++){(function(o){
      var b=document.createElement("button");
      b.className="btn btn-s btn-g"+(o.v===cur?" on":"");
      b.textContent=o.t; b.onclick=function(){fn(o.v);};
      el.appendChild(b);
    })(opts[i]);}
  }

  // ── Loaders ──
  var _loaded=false; // first load shows "Loading...", subsequent refreshes keep content
  function syncLabels(){
    var lbl=pLabel(S.period);
    $("lbl-pv").textContent="Total PV ("+lbl+")";
    $("lbl-uv").textContent="Total UV ("+lbl+")";
    $("lbl-plat").textContent="Platforms ("+lbl+")";
    var d=pDays(S.period); $("data-hint").textContent="Last "+d+(d===1?" day":" days");
  }

  function loadSummary(){
    var q={days:pDays(S.period),site_id:S.site}; if(S.slug)q.slug=S.slug;
    capi("analytics/summary?"+qs(q)).then(function(d){
      var pv=$("d-totalpv"), uv=$("d-totaluv");
      pv.className=""; pv.innerHTML='<div class="stat-row"><span class="stat-v">'+num(d.pv)+'</span><span class="stat-l">page views</span></div>';
      uv.className=""; uv.innerHTML='<div class="stat-row"><span class="stat-v">'+num(d.uv)+'</span><span class="stat-l">unique visitors</span></div>';
    }).catch(function(e){
      $("d-totalpv").className="err"; $("d-totalpv").textContent=e.message;
      $("d-totaluv").className="err"; $("d-totaluv").textContent=e.message;
    });
  }

  function loadStats(){
    syncLabels();
    api("analytics/active?"+qs({minutes:30,site_id:S.site})).then(function(d){
      var a=$("d-active");
      a.className=""; a.innerHTML='<div class="stat-row"><span class="dot"></span><span class="stat-v">'+num(d.count)+'</span><span class="stat-l">last '+d.minutes+' min</span></div>';
    }).catch(function(e){ $("d-active").className="err"; $("d-active").textContent=e.message; });

    api("health").then(function(d){
      var hp=$("d-health");
      hp.className=""; hp.innerHTML='<div class="stat-row"><span class="stat-v" style="font-size:18px">'+h(d.uptime||"--")+'</span><span class="stat-l">server uptime</span></div>';
    }).catch(function(e){ $("d-health").className="err"; $("d-health").textContent=e.message; });
  }

  var NS="http://www.w3.org/2000/svg";
  function svg(t,a){var e=document.createElementNS(NS,t);if(a)for(var k in a)e.setAttribute(k,a[k]);return e;}

  function loadTrend(){
    var el=$("d-trend");
    if(!_loaded) el.innerHTML='<div class="ld">Loading...</div>';
    tabs("trend-tabs",[{t:"1h",v:"1h"},{t:"6h",v:"6h"},{t:"1d",v:"1d"},{t:"7d",v:"7d"},{t:"30d",v:"30d"},{t:"90d",v:"90d"},{t:"180d",v:"180d"},{t:"1y",v:"365d"}],S.period,function(v){S.period=v;syncURL();syncLabels();loadStats();loadSummary();loadTrend();loadRef();loadPlat();loadPop();loadVis();loadViews();});
    var q={period:S.period,site_id:S.site}; if(S.slug)q.slug=S.slug;
    capi("analytics/trend?"+qs(q)).then(function(data){
      if(!data||!data.length){el.innerHTML='<div class="emp" style="line-height:160px">No data</div>';$("trend-leg").innerHTML="";return;}
      el.innerHTML="";
      var W=800,H=150,PL=44,PR=12,PT=10,PB=22,cw=W-PL-PR,ch=H-PT-PB,n=data.length;
      var mx=1,tpv=0,tuv=0;
      for(var i=0;i<n;i++){if(data[i].pv>mx)mx=data[i].pv;if(data[i].uv>mx)mx=data[i].uv;tpv+=data[i].pv;tuv+=data[i].uv;}
      mx=Math.ceil(mx*1.15)||1;
      // inline legend in title bar (color key only, totals in stat cards)
      $("trend-leg").innerHTML='<span class="tl-pv">\u2500 PV</span> &nbsp; <span class="tl-uv">\u2500 UV</span>';
      var s=svg("svg",{viewBox:"0 0 "+W+" "+H,preserveAspectRatio:"none"});
      // grid
      for(var g=0;g<=4;g++){var gy=PT+ch-ch*g/4;
        s.appendChild(svg("line",{x1:PL,y1:gy,x2:W-PR,y2:gy,stroke:"var(--border)","stroke-dasharray":g===0?"none":"2,2","stroke-width":"0.5"}));
        var t=svg("text",{x:PL-6,y:gy+3,fill:"var(--muted)","font-size":"8","text-anchor":"end"});t.textContent=Math.round(mx*g/4);s.appendChild(t);
      }
      function xp(i){return PL+(i/(n-1||1))*cw;}function yp(v){return PT+ch-(v/mx)*ch;}
      var pp=[],up=[];
      for(var i=0;i<n;i++){pp.push(xp(i).toFixed(1)+","+yp(data[i].pv).toFixed(1));up.push(xp(i).toFixed(1)+","+yp(data[i].uv).toFixed(1));}
      // areas
      var base=yp(0).toFixed(1);
      s.appendChild(svg("polygon",{points:xp(0).toFixed(1)+","+base+" "+pp.join(" ")+" "+xp(n-1).toFixed(1)+","+base,fill:"var(--accent)",opacity:"0.08"}));
      s.appendChild(svg("polygon",{points:xp(0).toFixed(1)+","+base+" "+up.join(" ")+" "+xp(n-1).toFixed(1)+","+base,fill:"var(--accent2)",opacity:"0.08"}));
      // lines
      s.appendChild(svg("polyline",{points:pp.join(" "),fill:"none",stroke:"var(--accent)","stroke-width":"1.5","stroke-linejoin":"round"}));
      s.appendChild(svg("polyline",{points:up.join(" "),fill:"none",stroke:"var(--accent2)","stroke-width":"1.5","stroke-linejoin":"round"}));
      // x labels
      var isHour=data[0].date.length>10;
      var step=n<=15?2:n<=30?5:n<=90?10:30;
      for(var i=0;i<n;i++){if(i%step===0||i===n-1){var l=svg("text",{x:xp(i),y:H-PB+16,fill:"var(--muted)","font-size":"8","text-anchor":"middle"});l.textContent=isHour?localHM(data[i].date):data[i].date.slice(5);s.appendChild(l);}}
      // hover
      var tip=$("tip");
      for(var i=0;i<n;i++){(function(idx){
        var hw=cw/n,rect=svg("rect",{x:xp(idx)-hw/2,y:PT,width:hw,height:ch,fill:"transparent"});
        var pd=svg("circle",{cx:xp(idx),cy:yp(data[idx].pv),r:"3",fill:"var(--accent)",opacity:"0","pointer-events":"none"});
        var ud=svg("circle",{cx:xp(idx),cy:yp(data[idx].uv),r:"3",fill:"var(--accent2)",opacity:"0","pointer-events":"none"});
        rect.onmouseenter=function(){tip.style.display="block";pd.setAttribute("opacity","1");ud.setAttribute("opacity","1");
          tip.innerHTML='<b>'+h(isHour?localTip(data[idx].date):data[idx].date)+'</b><br><span style="color:var(--accent)">PV '+data[idx].pv+'</span> &nbsp; <span style="color:var(--accent2)">UV '+data[idx].uv+'</span>';};
        rect.onmousemove=function(e){tip.style.left=(e.clientX+14)+"px";tip.style.top=(e.clientY-8)+"px";};
        rect.onmouseleave=function(){tip.style.display="none";pd.setAttribute("opacity","0");ud.setAttribute("opacity","0");};
        s.appendChild(rect);s.appendChild(pd);s.appendChild(ud);
      })(i);}
      el.appendChild(s);
      $("trend-label").textContent="PV / UV Trend"+(S.slug?" — "+S.slug:"");
    }).catch(function(e){el.innerHTML='<div class="err" style="line-height:160px;text-align:center">'+h(e.message)+'</div>';$("trend-leg").innerHTML="";});
  }

  function loadRef(){
    var el=$("d-ref");
    if(!_loaded) el.innerHTML='<div class="ld">Loading...</div>';
    var q={days:pDays(S.period),limit:10,site_id:S.site}; if(S.slug)q.slug=S.slug;
    capi("analytics/referrers?"+qs(q)).then(function(data){
      if(!data||!data.length){el.innerHTML='<div class="emp">No referrers</div>';return;}
      var mx=data[0].count||1,out="";
      for(var i=0;i<data.length;i++){var pct=Math.round(data[i].count/mx*100);
        out+='<div class="lr"><span class="lr-f">'+h(data[i].domain)+'</span>'+
          '<div class="lr-bar"><div class="lr-bar-f" style="width:'+pct+'%"></div></div>'+
          '<span class="lr-n">'+num(data[i].count)+'</span></div>';
      }
      el.innerHTML=out;
    }).catch(function(e){el.innerHTML='<div class="err">'+h(e.message)+'</div>';});
  }

  function loadPop(){
    tabs("pop-tabs",[{t:"10",v:10},{t:"20",v:20},{t:"30",v:30},{t:"50",v:50}],S.popN,function(v){S.popN=v;loadPop();});
    var el=$("d-pop");
    if(!_loaded) el.innerHTML='<div class="ld">Loading...</div>';
    capi("analytics/popular?"+qs({limit:S.popN,period:pPopPeriod(S.period),site_id:S.site})).then(function(data){
      if(!data||!data.length){el.innerHTML='<div class="emp">No articles</div>';return;}
      var out="";
      for(var i=0;i<data.length;i++){var t=data[i].page_title||data[i].page_slug;
        out+='<div class="lr"><span class="lr-r">'+(i+1)+'</span>'+
          '<span class="lr-f"><a href="#" onclick="drillSlug(\''+h(data[i].page_slug).replace(/'/g,"\\'")+'\');return false" title="'+h(data[i].page_slug)+'">'+h(t)+'</a></span>'+
          '<span class="lr-n">'+num(data[i].pv)+'</span></div>';
      }
      el.innerHTML=out;
    }).catch(function(e){el.innerHTML='<div class="err">'+h(e.message)+'</div>';});
  }

  var platColors={"Windows":"#0078d4","macOS":"#555","Linux":"#e95420","Android":"#3ddc84","iOS":"#007aff","Other":"#aaa"};
  var platIcons={"Windows":"\u{1F5A5}","macOS":"\u{1F34E}","Linux":"\u{1F427}","Android":"\u{1F4F1}","iOS":"\u{1F4F1}","Other":"\u{2753}"};
  function loadPlat(){
    var el=$("d-plat"); if(!_loaded) el.innerHTML='<div class="ld">Loading...</div>';
    capi("analytics/platforms?"+qs({days:pDays(S.period),site_id:S.site})).then(function(data){
      if(!data||!data.length){el.innerHTML='<div class="emp">No data</div>';return;}
      var total=0; for(var i=0;i<data.length;i++) total+=data[i].count;
      var mx=data[0].count||1; for(var i=1;i<data.length;i++){if(data[i].count>mx)mx=data[i].count;}
      var out="";
      for(var i=0;i<data.length;i++){
        var p=data[i],pct=total>0?Math.round(p.count/total*100):0;
        var clr=platColors[p.platform]||"#aaa";
        var ico=platIcons[p.platform]||"\u{2753}";
        out+='<div class="plat-row"><span class="plat-icon">'+ico+'</span><span class="plat-name">'+h(p.platform)+'</span>'+
          '<div class="plat-bar"><div class="plat-bar-f" style="width:'+Math.round(p.count/mx*100)+'%;background:'+clr+'"></div></div>'+
          '<span class="plat-pct">'+pct+'%</span><span class="plat-cnt">'+num(p.count)+'</span></div>';
      }
      el.innerHTML=out;
    }).catch(function(e){el.innerHTML='<div class="err">'+h(e.message)+'</div>';});
  }

  function loadVis(){
    var el=$("d-vis");
    if(!_loaded) el.innerHTML='<div class="ld">Loading...</div>';
    if(S.fp){
      api("analytics/visitor?"+qs({fingerprint:S.fp,days:pDays(S.period),limit:S.rLim,offset:S.rOff,site_id:S.site})).then(function(d){
        if(!d||!d.records||!d.records.length){el.innerHTML='<div class="emp">No records</div>';return;}
        var out='<div style="margin-bottom:10px"><button class="btn btn-s btn-g" onclick="backVis()">&larr; All visitors</button>'+
          ' <span class="tag">'+h(S.fp.slice(0,8))+'</span></div>';
        out+='<div class="tbl-w"><table class="tbl"><tr><th>Time</th><th>Page</th><th>IP</th><th>Referrer</th><th>UA</th></tr>';
        for(var i=0;i<d.records.length;i++){var r=d.records[i];
          out+='<tr><td class="td-time">'+h(toLocal(r.created_at))+'</td>'+
            '<td><a href="#" onclick="drillSlug(\''+h(r.page_slug).replace(/'/g,"\\'")+'\');return false">'+h(r.page_title||r.page_slug)+'</a></td>'+
            '<td class="td-ip">'+h(r.ip)+'</td><td class="td-ref">'+h(r.referrer||"-")+'</td>'+
            '<td class="td-ua">'+h(r.user_agent)+'</td></tr>';
        }
        out+='</table></div>'+pgr(d.total,d.limit,d.offset,"vpg");
        el.innerHTML=out;
      }).catch(function(e){el.innerHTML='<div class="err">'+h(e.message)+'</div>';});
      return;
    }
    api("analytics/visitors?"+qs({days:pDays(S.period),limit:S.rLim,offset:S.rOff,site_id:S.site})).then(function(data){
      if(!data||!data.length){el.innerHTML='<div class="emp">No visitors yet</div>';return;}
      var out='<div class="tbl-w"><table class="tbl"><tr><th>Fingerprint</th><th>Last Page</th><th>IP</th><th>PV</th><th>Last Seen</th></tr>';
      for(var i=0;i<data.length;i++){var v=data[i];
        out+='<tr><td class="td-fp"><a href="#" onclick="viewFp(\''+h(v.fingerprint)+'\');return false" title="'+h(v.fingerprint)+'">'+h(v.fingerprint.slice(0,8))+'</a></td>'+
          '<td title="'+h(v.last_page)+'">'+h(v.last_page_title||v.last_page)+'</td>'+
          '<td class="td-ip">'+h(v.last_ip)+'</td>'+
          '<td>'+v.page_views+'</td>'+
          '<td class="td-time">'+h(toLocal(v.last_seen))+'</td></tr>';
      }
      out+='</table></div>';
      el.innerHTML=out;
    }).catch(function(e){el.innerHTML='<div class="err">'+h(e.message)+'</div>';});
  }
  window.vpg=function(o){S.rOff=o;loadVis();};

  function loadViews(){
    var el=$("d-views");
    if(!_loaded) el.innerHTML='<div class="ld">Loading...</div>';
    var q={days:pDays(S.period),limit:S.vLim,offset:S.vOff,site_id:S.site}; if(S.slug)q.slug=S.slug;
    api("analytics/views?"+qs(q)).then(function(d){
      if(!d||!d.records||!d.records.length){el.innerHTML='<div class="emp">No records</div>';return;}
      var out='<div class="tbl-w"><table class="tbl"><tr><th>Time</th><th>Page</th><th>IP</th><th>Fingerprint</th><th>Referrer</th><th>UA</th></tr>';
      for(var i=0;i<d.records.length;i++){var r=d.records[i];
        out+='<tr><td class="td-time">'+h(toLocal(r.created_at))+'</td>'+
          '<td><a href="#" onclick="drillSlug(\''+h(r.page_slug).replace(/'/g,"\\'")+'\');return false">'+h(r.page_title||r.page_slug)+'</a></td>'+
          '<td class="td-ip">'+h(r.ip)+'</td>'+
          '<td class="td-fp"><a href="#" onclick="viewFp(\''+h(r.fingerprint)+'\');return false" title="'+h(r.fingerprint)+'">'+h(r.fingerprint.slice(0,8))+'</a></td>'+
          '<td class="td-ref">'+h(r.referrer||"-")+'</td>'+
          '<td class="td-ua">'+h(r.user_agent)+'</td></tr>';
      }
      out+='</table></div>'+pgr(d.total,d.limit,d.offset,"vwpg");
      el.innerHTML=out;
    }).catch(function(e){el.innerHTML='<div class="err">'+h(e.message)+'</div>';});
  }
  window.vwpg=function(o){S.vOff=o;loadViews();};

  function pgr(total,lim,off,fn){
    var pages=Math.ceil(total/lim),cur=Math.floor(off/lim)+1;
    return '<div class="pgr"><span>'+num(total)+' records &middot; page '+cur+'/'+pages+'</span><div class="pgr-btns">'+
      (off>0?'<button class="btn btn-s btn-g" onclick="'+fn+'('+(off-lim)+')">Prev</button>':'')+
      (off+lim<total?'<button class="btn btn-s btn-g" onclick="'+fn+'('+(off+lim)+')">Next</button>':'')+
      '</div></div>';
  }

  function refresh(){
    syncTag(); S.vOff=0;
    loadTrend(); loadRef(); loadViews();
  }

  window.loadAll=function(){
    _cache={};
    S.site=elSite.value.trim()||window.location.hostname;
    S.slug=elSlug.value.trim(); S.fp=""; S.vOff=0; S.rOff=0;
    syncURL(); syncTag();
    loadStats(); loadSummary(); loadTrend(); loadRef(); loadPlat(); loadPop(); loadVis(); loadViews();
    var _now=new Date(); var _tz=_now.toLocaleTimeString("en",{timeZoneName:"short"}).split(" ").pop(); $("ts").textContent="| "+_now.getFullYear()+"-"+pad2(_now.getMonth()+1)+"-"+pad2(_now.getDate())+" "+pad2(_now.getHours())+":"+pad2(_now.getMinutes())+":"+pad2(_now.getSeconds())+" "+_tz;
    _loaded=true;
  };

  // ── Auto-refresh ──
  var _autoTimer=null;
  window.setAutoRef=function(v){
    if(_autoTimer){clearInterval(_autoTimer);_autoTimer=null;}
    var sec=parseInt(v)||0;
    if(sec>0) _autoTimer=setInterval(function(){loadAll();},sec*1000);
  };

  setInterval(function(){
    api("analytics/active?"+qs({minutes:30,site_id:S.site})).then(function(d){
      var el=$("d-active");
      el.innerHTML='<div class="stat-row"><span class="dot"></span><span class="stat-v">'+num(d.count)+'</span><span class="stat-l">last '+d.minutes+' min</span></div>';
    }).catch(function(){});
  },60000);

  loadAll();
})();
</script>
</body>
</html>`

// DashboardHandler serves the analytics dashboard HTML page.
type DashboardHandler struct {
	html string
}

// NewDashboardHandler creates a new dashboard handler.
func NewDashboardHandler(version string) *DashboardHandler {
	html := strings.Replace(dashboardHTML, "{{VERSION}}", version, 1)
	return &DashboardHandler{html: html}
}

// HandleDashboard serves the self-contained analytics dashboard.
func (h *DashboardHandler) HandleDashboard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is allowed")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(h.html))
}
