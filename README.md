# videasy-proxy

A tiny **Cloudflare Worker** that reverse-proxies [`player.videasy.to`](https://player.videasy.to) and **strips the `ab.js` ad script**. You get the full Videasy player on your own `*.workers.dev` URL, ad-script removed, embeddable anywhere.

```
https://<your-worker>.workers.dev/tv/1434/1/1   →  player.videasy.to/tv/1434/1/1
https://<your-worker>.workers.dev/movie/550     →  player.videasy.to/movie/550
```

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fartboblover3/videasy-proxy)

Click the button, connect your Cloudflare account, and it deploys straight from this repo — no local setup. When it's done you'll get a `https://videasy-proxy.<your-subdomain>.workers.dev` URL.

## Usage

Once deployed, use it exactly like the Videasy player, but on your worker URL:

```html
<!-- Movie -->
<iframe src="https://your-worker.workers.dev/movie/550" allowfullscreen></iframe>

<!-- TV episode: /tv/{tmdbId}/{season}/{episode} -->
<iframe src="https://your-worker.workers.dev/tv/1434/1/1" allowfullscreen></iframe>
```

Any path works — the worker proxies whatever you request to the same path on `player.videasy.to`.

## What it does

- **Proxies only Videasy's own domains** — `videasy.to` and every `*.videasy.to` subdomain flow through your worker (the player page, its scripts, styles, and API calls).
- **Leaves every other domain alone** — stream CDNs and any non-Videasy host load **directly** in the browser, untouched. This is deliberate: HLS `.m3u8` playlists are often bound to their CDN domain (referer/token/same-origin segment rules), so proxying them would break playback. Loading them naturally keeps them working.
- **Removes the `ab.js` ad script everywhere** — the `<script>` tag is stripped from the HTML, any direct request for `ab.js` returns an empty response, and the injected shim drops it at runtime **no matter which domain it comes from**. Every other script loads normally.
- **Drops `Content-Security-Policy` / `X-Frame-Options`** and adds permissive CORS, so the player embeds cleanly in an iframe from any site.

How the Videasy rerouting works: bare paths (`/tv/…`, `/movie/…`) forward to `player.videasy.to`; other Videasy subdomains are routed as `/_ext/<encoded url>` (and `/_ext` refuses any non-Videasy URL, so this can't be used as an open proxy); and a tiny injected shim rewrites **runtime** Videasy requests (`fetch`, `XMLHttpRequest`, `EventSource`, `sendBeacon`, dynamically-added elements) — while passing non-Videasy requests straight through.

## Configuration

Everything lives in [`src/index.js`](src/index.js). A few constants at the top control it:

```js
const UPSTREAM_HOST = "player.videasy.to"; // where bare paths (/tv, /movie) go
const PROXY_DOMAINS = ["videasy.to"];      // domains routed through the worker (+ subdomains)
const AD_NAMES = ["ab.js"];                // script filenames to block (add more here)
```

- `UPSTREAM_HOST` — the site bare paths land on.
- `PROXY_DOMAINS` — which domains get proxied; anything not matching loads directly. Add more hosts if you want them proxied too.
- `AD_NAMES` — filenames to block anywhere, on any domain.

To rename the worker (and its URL), edit `name` in [`wrangler.toml`](wrangler.toml).

## Local development

```bash
npm install
npm run dev        # runs the worker locally at http://localhost:8787
# then open http://localhost:8787/movie/550
```

Deploy manually (instead of the button) with:

```bash
npx wrangler login
npm run deploy
```

## Disclaimer

This proxies a third-party service you do not control; it does not host or store any media. You are responsible for how you deploy and use it and for complying with the terms of the upstream service and the laws in your jurisdiction. Provided as-is, no warranty.
