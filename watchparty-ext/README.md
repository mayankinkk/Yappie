# WatchParty Sync

A browser extension that keeps everyone in a room on the same frame of an HTML5 `<video>`. Synchronized play / pause / seek, drift correction, a member list, and text chat.

**Each viewer signs in to whatever service they're watching on their own account.** This tool only relays control events — it carries no video, no credentials, and no account.

> Separate from Yappie. Yappie (`../src`) is untouched by this; it's a standalone extension plus a small relay you run yourself.

## What it is / isn't

| | |
| --- | --- |
| **Is** | A sync layer over any page with a `<video>` element. Think "Teleparty, but self-hosted and site-agnostic." |
| **Isn't** | A streaming service, a catalog, a DRM client, or a way to share one subscription between people. |

It works on: local files, self-hosted media (Plex/Jellyfin/Emby in a browser), free ad-supported services that allow in-browser playback, and any page where every participant is already entitled to press play.

## Layout

```
watchparty-ext/
  config.js         the one place the relay URL is set
  manifest.json     MV3 manifest (storage + activeTab only)
  background.js     badge + tab state relay (no sync logic)
  content.js        <video> hook, sync engine, Shadow DOM panel
  popup.{html,css,js}  create / join / leave / settings
  icons/            16 / 48 / 128
  relay/
    server.js       in-memory WebSocket relay (rooms, host election, rate limit)
    Dockerfile      container for deploying it
  store/            Chrome Web Store package (privacy policy + listing)
  e2e/sync.test.mjs two-client Playwright test against a live relay
```

## Run it

### 1. Start the relay

```bash
cd relay
npm install
npm start          # ws://0.0.0.0:8787, health at /healthz
```

Set `PORT` or `HOST` to change it (`HOST=127.0.0.1` to keep it local-only). It holds rooms in memory — restarting it drops all rooms.

### 2. Point the extension at it

`config.js` is the single source of truth:

```js
globalThis.WP_CONFIG = { WS_RELAY_URL: "ws://localhost:8787" };
```

For local dev that value is fine. **For anything the extension will connect to from an `https://` page, it must be `wss://`** — browsers block a plain `ws://` connection from an https page as mixed content. Set it once in `config.js`; the popup's Advanced section can still override it per-device.

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `watchparty-ext/` folder

### 4. Watch together

1. Open a page with a video on **both** machines
2. Click the extension icon → **Create a room** on one, **Join** with the code on the other
3. The pill in the top-right corner shows the room and measured drift; click it for members, chat, and the host's control lock

To invite via link, use **Copy invite** in the panel — it appends `#wp=CODE` and auto-joins.

## How sync works

Position is anchored to **receipt time**, not the sender's wall clock. A peer sends `{videoId, time, playing, seq}`; the receiver stores `receivedAt` locally and computes the target as `time + elapsed`. Ordering rides on a per-sender `seq`, so peers with disagreeing clocks still line up — the cost is inheriting one transit delay (~50–200ms on the open internet) instead of clock error, which is well under the re-sync threshold.

Every second, each client measures drift against the host's anchor and re-seeks if it exceeds **0.75s**. Applies are guarded for ~900ms so our own remote-apply doesn't echo back out as a local event.

**Video identity** is `pageURL#durationSeconds`. Two people on the same title's page match; a direct media URL matches by filename in the path. Blob / MSE sources are deliberately excluded — they differ per client and would never match. If the host is on a different title than you, the panel says so instead of seeking blindly.

**Host** is server-elected: whoever joined the room longest ago. The host can lock playback to themselves or unlock it for everyone. Guests who try to control while locked send a request the host sees as a prompt.

## Relay protocol

Client → server: `join` (with `create` or `room`), `control`, `sync-request`, `control-request`, `room-settings` (host only), `chat`, `rename`, `leave`.

Server → clients: `joined`, `peers` (with host flags), `control` (sender id/name rewritten), `sync-request`, `control-request`, `room-settings`, `chat`, `host-changed`, `error`, `left`.

The relay enforces a 20 msg/s token bucket per connection, a 500-char chat cap, and rejects `room-settings` from anyone but the elected host. `control` payloads are validated but not signed — a participant inside a room can forge events under another member's id. That's the same trade-off Yappie makes; it's bounded to ephemeral playback state, and room membership, host, and settings are all server-side.

## Limitations

- **DRM (Widevine) sites** — control hooks still fire on the `<video>`, but browsers cap those streams at lower quality in an extension context, and some players ignore programmatic seeks. Self-hosted and free/ad-supported sources are the reliable case.
- **One video per page.** It syncs the largest rendered `<video>`. Sites with multiple simultaneous players pick one.
- **No queue / catalog.** Everyone navigates to the same title themselves. This syncs playback, not discovery.
- **Rooms are in-memory.** Restart the relay and every room is gone. Add persistence (Redis, or Supabase Realtime like Yappie uses) if you want durability.
- **Relay is unauthenticated.** Room codes are 6 chars from a 32-char alphabet (~1B combos), but anyone with a code walks in. Add a shared secret per room if you need real access control.
- **`<all_urls>` content script.** Required for a site-agnostic tool — it runs on every page so the sync is there whenever a video is. The script only touches `<video>` elements and its own Shadow DOM; it doesn't read page content. Review it, it's one file.

## Development

```bash
node --check content.js     # syntax
node --check background.js
cd relay && npm start       # relay on :8787
```

No build step — it's plain JS loaded unpacked. Edit, then hit reload on `chrome://extensions`.

### Tests

```bash
node e2e/sync.test.mjs
```

Opens two isolated Chromium profiles with the extension loaded (separate storage → separate identities, like two friends on two laptops), spins up a real relay, and verifies join, play-follow, seek, resume, pause, and drift over live sockets. Passes only if every check is green. First run generates `e2e/fixtures/clip.webm` in the browser, so no binary ships in the repo.

Requires Playwright's Chromium: `npx playwright install chromium`. Uses `channel: "chromium"` (the new headless), because the old headless mode doesn't load extensions.

### Deploying the relay

```bash
docker build -t wp-relay ./relay
docker run -p 8787:8787 wp-relay
```

Listens on `0.0.0.0:8787`, answers `GET /healthz` with `{ok, rooms, peers, uptime}`, and shuts down cleanly on SIGTERM/SIGINT (closes sockets, clears timers). It terminates plain `ws://` — put TLS in front (Fly, Render, Railway, or any nginx/caddy), then set `WS_RELAY_URL` in `config.js` to that `wss://` endpoint.

## Publishing to the Chrome Web Store

Full package in [`store/`](store/): `privacy-policy.md` (fill in the date and contact, host it publicly) and `listing.md` (single purpose sentence, permission justifications for `storage` / `activeTab` / `<all_urls>`, data-collection disclosure table, asset checklist).

Gate before submitting — all four are in `store/listing.md`:

1. `config.js` → `WS_RELAY_URL` is a live `wss://` URL, not `ws://localhost`
2. Relay deployed and answering `/healthz` over TLS
3. Privacy policy hosted at a public HTTPS URL
4. `node e2e/sync.test.mjs` passing against the *deployed* relay

Permissions are deliberately minimal: `storage` (your id, name, relay override) and `activeTab` (invite-link URL on your own click). There is no `tabs`, `history`, `cookies`, `webRequest`, or `scripting` — the invite link reads `location.href` from the content script instead of `tab.url` for exactly that reason.

## Where this sits next to Yappie

Yappie does synced YouTube playback with a durable room model (Supabase Postgres + Realtime), chat, queue, reactions, and optional LiveKit voice. This extension is the browser-native complement: it reaches sources Yappie's IFrame player can't (anything that isn't YouTube), using the same sync ideas — receipt-time anchoring, a 0.75s re-sync threshold, server-elected host.

If you want them to converge, the natural next step is a shared sync core (both currently reimplement the drift math) or having the extension join a Yappie room as just another client type. Neither is done here.
