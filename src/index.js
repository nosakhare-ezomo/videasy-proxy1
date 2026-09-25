/**
 * Cloudflare Worker — reverse proxy for Videasy that ONLY proxies Videasy's own
 * domains and lets every other domain load directly.
 *
 *   https://<your-worker>.workers.dev/tv/1434/1/1   ->  player.videasy.to/tv/1434/1/1
 *   https://<your-worker>.workers.dev/movie/550     ->  player.videasy.to/movie/550
 *
 * Behaviour:
 *   • videasy.to and *.videasy.to  -> proxied through this worker.
 *   • every other domain (stream CDNs, etc.) -> left ALONE and loaded directly
 *     by the browser, so domain-bound HLS (.m3u8) links, tokens and referers
 *     keep working naturally.
 *   • any script named `ab.js` (the ad script) is blocked everywhere — in the
 *     HTML, on direct requests through the worker, and at runtime via the shim,
 *     regardless of which domain it comes from.
 *
 * Config: edit the constants below.
 */

const UPSTREAM_HOST = "player.videasy.to"; // where bare paths (/tv, /movie) go
const UPSTREAM = "https://" + UPSTREAM_HOST;
const EXT_PREFIX = "/_ext/"; // proxied non-default Videasy subdomain URL

// Domains we proxy. Anything matching (exact host or a subdomain) is routed
// through the worker; everything else loads directly.
const PROXY_DOMAINS = ["videasy.to"];

// Block any request whose filename (last path segment) is one of these.
const AD_NAMES = ["ab.js"];

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const workerOrigin = reqUrl.origin;

    // ---- resolve the real target ----
    let target;
    if (reqUrl.pathname.startsWith(EXT_PREFIX)) {
      try {
        target = new URL(decodeURIComponent(reqUrl.pathname.slice(EXT_PREFIX.length)));
      } catch {
        return new Response("bad target", { status: 400 });
      }
      // Only ever proxy Videasy domains — never an open proxy for the internet.
      if (!isProxyDomain(target.hostname)) {
        return new Response("forbidden", { status: 403 });
      }
    } else {
      target = new URL(UPSTREAM + reqUrl.pathname + reqUrl.search);
    }

    // ---- block ad scripts by filename ----
    const base = (target.pathname.split("/").pop() || "").toLowerCase();
    if (AD_NAMES.includes(base)) {
      return new Response("/* blocked */", {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "*",
        },
      });
    }

    // ---- forward to the target ----
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set("Host", target.host);
    reqHeaders.set("Referer", UPSTREAM + "/");
    reqHeaders.set("Origin", UPSTREAM);
    reqHeaders.delete("accept-encoding");
    reqHeaders.delete("cf-connecting-ip");
    reqHeaders.delete("cf-ipcountry");
    reqHeaders.delete("x-forwarded-host");

    const method = request.method;
    const upstream = await fetch(target.toString(), {
      method,
      headers: reqHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    // ---- clean response headers ----
    const headers = new Headers(upstream.headers);
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
    headers.delete("x-frame-options");
    headers.delete("content-length");
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-headers", "*");
    headers.set("access-control-allow-methods", "*");

    const location = upstream.headers.get("location");
    if (location) {
      try {
        headers.set("location", toProxied(new URL(location, target).href, workerOrigin));
      } catch {}
    }

    const ct = (upstream.headers.get("content-type") || "").toLowerCase();

    // ---- HTML: strip ad tags, inject the shim ----
    if (ct.includes("text/html")) {
      let html = await upstream.text();
      html = html.replace(/<base\b[^>]*>/gi, "");
      for (const ad of AD_NAMES) {
        const esc = ad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(
          new RegExp(`<script\\b[^>]*\\b${esc}\\b[^>]*>\\s*</script>`, "gi"),
          ""
        );
        html = html.replace(new RegExp(`<script\\b[^>]*\\b${esc}\\b[^>]*/?>`, "gi"), "");
      }
      const inject = "<script>" + CLIENT_SHIM + "</script>";
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => m + inject);
      } else {
        html = inject + html;
      }
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(html, { status: upstream.status, headers });
    }

    // ---- CSS: rewrite only Videasy url()/@import; leave external ones ----
    if (ct.includes("text/css")) {
      let css = await upstream.text();
      css = css.replace(
        /url\(\s*(['"]?)\s*((?:https?:)?\/\/[^'")\s]+)\s*\1\s*\)/gi,
        (_m, q, u) => `url(${q}${toProxied(absolutize(u, target), workerOrigin)}${q})`
      );
      return new Response(css, { status: upstream.status, headers });
    }

    // ---- everything else: stream through unchanged ----
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

function isProxyDomain(host) {
  host = (host || "").toLowerCase();
  return PROXY_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

/** Absolute URL -> worker route IF it's a Videasy domain, else unchanged. */
function toProxied(absHref, workerOrigin) {
  try {
    const u = new URL(absHref);
    if (!isProxyDomain(u.hostname)) return absHref; // external: leave direct
    if (u.host === UPSTREAM_HOST) return u.pathname + u.search;
    return workerOrigin + EXT_PREFIX + encodeURIComponent(u.href);
  } catch {
    return absHref;
  }
}

function absolutize(u, baseUrl) {
  if (u.startsWith("//")) u = "https:" + u;
  try {
    return new URL(u, baseUrl).href;
  } catch {
    return u;
  }
}

// Injected into every proxied HTML page. Reroutes ONLY Videasy requests through
// the worker, leaves every other domain to load directly, and blocks anything
// named like an ad script. Dependency-free and backtick-free.
const CLIENT_SHIM = `
(function(){
  var W = location.origin;
  var EXT = W + "${EXT_PREFIX}";
  var UP = "${UPSTREAM_HOST}";
  var DOMAINS = ${JSON.stringify(PROXY_DOMAINS)};
  var AD = ${JSON.stringify(AD_NAMES)};
  function host(u){ try { return (new URL(u, location.href)).hostname.toLowerCase(); } catch(e){ return ""; } }
  function isProxy(h){ h = (h||"").toLowerCase(); for (var i=0;i<DOMAINS.length;i++){ var d = DOMAINS[i]; if (h === d || h.slice(-(d.length+1)) === "."+d) return true; } return false; }
  function baseName(u){ try { return (new URL(u, location.href)).pathname.split("/").pop().toLowerCase(); } catch(e){ return ""; } }
  function isAd(u){ return AD.indexOf(baseName(u)) !== -1; }
  function rw(u){
    if (u == null) return u;
    try {
      u = String(u);
      if (!u) return u;
      if (/^(data:|blob:|javascript:|about:|mailto:|#)/i.test(u)) return u;
      if (isAd(u)) return "data:application/javascript,";        // block ad, any domain
      var abs = new URL(u, location.href);
      if (abs.origin === W) return abs.href;                     // already through worker
      if (isProxy(abs.hostname)) {                               // Videasy -> worker
        if (abs.hostname === UP) return abs.pathname + abs.search;
        return EXT + encodeURIComponent(abs.href);
      }
      return u;                                                  // everything else -> direct
    } catch(e){ return u; }
  }
  var _fetch = window.fetch;
  if (_fetch) window.fetch = function(input, init){
    try {
      if (typeof input === "string") input = rw(input);
      else if (input && input.url) input = new Request(rw(input.url), input);
    } catch(e){}
    return _fetch.call(this, input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(){ try { arguments[1] = rw(arguments[1]); } catch(e){} return _open.apply(this, arguments); };
  try { if (navigator.sendBeacon){ var _sb = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function(u, d){ return _sb(rw(u), d); }; } } catch(e){}
  try { if (window.EventSource){ var _ES = window.EventSource; window.EventSource = function(u, c){ return new _ES(rw(u), c); }; window.EventSource.prototype = _ES.prototype; } } catch(e){}
  function fixEl(el){
    try {
      if (!el || el.nodeType !== 1) return;
      var t = el.tagName;
      if (t === "SCRIPT" || t === "IMG" || t === "SOURCE" || t === "VIDEO" || t === "AUDIO" || t === "IFRAME" || t === "TRACK" || t === "EMBED"){
        var s = el.getAttribute("src");
        if (s){ if (isAd(s)){ if (el.remove) el.remove(); return; } var r = rw(s); if (r !== s) el.setAttribute("src", r); }
      }
      if (t === "LINK"){ var h = el.getAttribute("href"); if (h){ var r2 = rw(h); if (r2 !== h) el.setAttribute("href", r2); } }
    } catch(e){}
  }
  try {
    var mo = new MutationObserver(function(muts){
      for (var i=0;i<muts.length;i++){
        var nodes = muts[i].addedNodes;
        for (var j=0;j<nodes.length;j++){
          var n = nodes[j];
          fixEl(n);
          if (n.querySelectorAll){ var q = n.querySelectorAll("script,img,source,video,audio,iframe,link,track,embed"); for (var k=0;k<q.length;k++) fixEl(q[k]); }
        }
      }
    });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch(e){}
})();
`;
