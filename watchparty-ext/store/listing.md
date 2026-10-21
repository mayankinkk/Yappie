# Chrome Web Store — listing package

Everything a reviewer needs in one place. Copy the sections into the store form.

---

## Single purpose

**Describe the extension's single purpose in one sentence:**

> Synchronize play, pause, and seek of an HTML5 video between people watching the same video, and provide a text chat alongside it.

Every permission and content-script match below exists only to serve this purpose. The extension does nothing else.

---

## Detailed description

WatchParty Sync keeps you and your friends on the same frame.

You are all watching the same thing anyway — this just stops the drift. Create a room, share the six-character code, and when the host presses play, pauses, or skips, everyone else does too. A drift counter shows how far off you are, and re-seeks automatically past three-quarters of a second.

**What it does**

- Syncs play, pause, and seek across everyone in a room
- Shows measured drift against the host, with automatic re-sync
- Server-elected host: the host can lock playback to themselves or unlock it for everyone
- Room chat and a who's-watching list with host badge
- Invite by six-character code or a copied link
- Works on any page with a video — local files, self-hosted media, free ad-supported services

**What it deliberately does not do**

- It does not stream, host, or proxy any video. Playback stays in your own browser, from your own copy.
- It does not share accounts or credentials. Everyone signs in to whatever service they are using on their own.
- It collects no analytics, no browsing history, and no page contents.

The relay server is open source and self-hostable — point the extension at your own instance from the popup's Advanced section.

---

## Why `<all_urls>` (content script match)

The extension's entire purpose is to sync a video playing in the current tab, and videos appear on unpredictable origins — a self-hosted media server on one port, a free streaming site on another, a local `file://` page, and so on. There is no fixed list of sites that plays video, so a static allowlist would silently fail on most of them.

Restricting to `<all_urls>` at install time is the only way to offer a site-agnostic sync tool. The content script:

- runs at `document_idle` (after the page loads),
- in the top frame only (`all_frames: false`),
- touches only `<video>` elements and its own closed-off UI (a Shadow DOM root it creates),
- does not read page text, form data, cookies, credentials, or browsing history,
- sends only playback position, playing state, the page URL and video duration (to confirm two people are on the same title), and messages you type yourself.

No host permission beyond this content script match is requested, and no `tabs`, `webRequest`, `cookies`, `history`, or `scripting` permission is used.

---

## Permission justifications

### `storage`

Stores three small values locally on the device:

- a randomly generated client identifier, so the relay can recognise a reconnect from the same client rather than creating a duplicate member,
- the display name the user types,
- the relay server URL, if the user overrides the default.

Nothing else is stored and nothing is synced to `chrome.storage.sync`.

### `activeTab`

Used only to read the current page's URL when the user clicks **Copy invite link**, so the copied link points at the page they are on. This is granted by the user's own click on the extension action, is not requested at install time, and the URL is never transmitted — it only forms the `#wp=CODE` fragment of the copied link.

Note: `tab.url` is deliberately *not* read for this. The content script replies with its own `location.href` instead, which is why `activeTab` remains available only as a fallback.

---

## Data collection disclosure (store form)

Answer **"Yes, user data is collected"** and fill in:

| Field | Answer |
| --- | --- |
| Personal info | Display name (free text, user-entered, optional) |
| Website content | Playback position and playing state of the video in the current tab; page URL and video duration |
| User communications | Chat messages the user types |
| Usage statistics | None |
| History | None |
| Financial info | None |

**How it's used:** to relay playback control and chat to other members of the room the user is in.

**Is it shared with third parties:** No. It is sent only to other members of the user's own room, via the relay server.

**Retention:** Rooms, roster, and chat live in relay memory only. Restarting the relay erases them. Nothing is written to a database.

**Privacy policy URL:** required before submission — host `store/privacy-policy.md` at a public HTTPS URL and paste that link.

---

## Store assets checklist

- [ ] Privacy policy hosted at a public HTTPS URL (from `store/privacy-policy.md` — fill in `[DATE]` and `[Your contact email or support URL]` first)
- [ ] 1280×800 or 640×400 promo graphic
- [ ] At least 1 screenshot, up to 5 (see below)
- [ ] Category: **Tools** (or **Entertainment**)
- [ ] Language: English
- [ ] `wss://` relay URL set in `config.js` — the shipped default is `ws://localhost`, which only works on the developer's machine
- [ ] Developer account ($5 one-time) and verified publisher email

### Suggested screenshots

1. The pill and panel open on a video page, showing members + drift.
2. Two windows side by side playing the same frame, drift reading `0.00s`.
3. The popup with a room code and the invite-link button.

---

## Pre-submission gate

Do not submit until all of these are true:

1. `config.js` → `WS_RELAY_URL` points at a live `wss://` endpoint (a plain `ws://` URL is blocked as mixed content on any `https://` page).
2. The relay is deployed, answers `GET /healthz` with 200, and is reachable over TLS.
3. `store/privacy-policy.md` is hosted publicly with the placeholder fields filled in.
4. `node e2e/sync.test.mjs` passes against the *deployed* relay, not just localhost.
