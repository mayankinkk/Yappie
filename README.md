# Sofa

Watch YouTube together, in perfect sync. Rooms with synced playback, chat (with emoji, per-message reactions, typing indicators, and host moderation), reactions, a shared queue with upvoting, watch history, and optional voice chat.

## Stack

- React 19 + TypeScript + Vite
- YouTube IFrame API (synced player)
- Supabase Realtime (rooms, presence, chat — no backend database needed)
- Supabase anonymous auth (stable guest identity)
- LiveKit Cloud (optional voice chat, token minted by a Supabase Edge Function)

## Quickstart

```bash
npm install
cp .env.example .env.local   # fill in your Supabase keys
npm run dev
```

You can also skip `.env.local` entirely — on first run the app shows a setup overlay where you paste your Supabase Project URL and anon key (stored in localStorage).

### Get Supabase keys

1. Create a free project at [supabase.com](https://supabase.com)
2. **Project Settings → API** → copy the Project URL and anon public key
3. **Enable anonymous sign-in** — Authentication → Providers → Anonymous. It is **off by default** on new projects; the app cannot sign anyone in without it.
4. **Apply the database migrations** — paste every file in [`supabase/migrations/`](supabase/migrations/) into the SQL editor in numeric order (0001 → 0009), or run `supabase db push` if you use the CLI. The app does not work without them: rooms, membership, host authority, chat history, grants, watch history, host message deletion, chat reactions, queue voting, and the RLS helpers live in Postgres. (0005/0006 fix pgcrypto search-path and RLS recursion issues that bite on fresh projects.)
5. *(Optional)* **Authentication → Providers → Google** — enable it (OAuth client ID/secret from Google Cloud Console) to light up "Continue with Google" on the landing page. Without it the button shows a clear error and everything else works.

## Voice chat (optional)

1. Create a free [LiveKit Cloud](https://cloud.livekit.io) project — copy the **URL**, **API key**, and **API secret**
2. Put `VITE_LIVEKIT_URL` in `.env.local` (or leave env empty and deploy the edge function; the in-app overlay accepts the Supabase keys only)
3. Deploy the token function:

```bash
supabase functions deploy livekit-token --secret-ref LIVEKIT_API_KEY=<key> --secret-ref LIVEKIT_API_SECRET=<secret>
```

The function also needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` (auto-injected by Supabase). When LiveKit isn't configured, the voice bar simply doesn't render.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` | typecheck + production build to `dist/` |
| `npm test` | unit tests for the sync engine, rate limiters, recent rooms, and video-id parsing |
| `npm run test:e2e` | Playwright two-client tests (needs `.env.local` keys + migrations; skips otherwise) |
| `npm run lint` | ESLint over `src/` |
| `npm run preview` | serve the production build |

## Two-client E2E

`npm run test:e2e` opens **two isolated browser contexts** (separate storage → separate anonymous users, like two friends on two laptops) and verifies the full flow over a live Supabase project: room create/join, presence, chat round-trip through Postgres, host playback lock, queue sync, invite-only lock rejection, and the room-password prompt (wrong vs right password). First run: `npx playwright install chromium`.

CI runs lint + typecheck + unit tests + build on every push; the E2E suite runs locally (it needs real Supabase credentials).

## Deploy

Static hosting, no server needed:

- **Vercel**: `vercel deploy` (config in `vercel.json`)
- **Netlify**: `netlify deploy --prod` (config in `netlify.toml`)
- **GitHub Pages**: `npm run build` then publish `dist/`

After you know your production URL, add `og:url` and `og:image` (absolute URLs — e.g. `/icons/icon-512.png` served from your domain) to `index.html` for richer link previews.

Set the env vars in your host's dashboard (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_LIVEKIT_URL`, optional `VITE_SENTRY_DSN` for error monitoring) so first-time visitors skip the setup overlay.

## How sync works

Each room is a Supabase Realtime channel. Playback state (video id, timestamp, playing) is broadcast on every play/pause/seek; every other client applies it, advancing the timestamp by elapsed time for late arrivals. Clients that drift more than 0.75s off the shared timeline re-seek every 5s. Durable room state (host, permissions, queue, membership, grants) lives in Postgres — see below. A **sync pill** under the player shows measured drift vs the host (green <0.5s, yellow <1.5s, red beyond), refreshed every 5s.

**Keyboard shortcuts** (when focus isn't in a text field): `Space` play/pause · `←`/`→` seek 5s · `Shift+←`/`→` seek 30s · `↑`/`↓` volume · `F` fullscreen · `M` mute · `T` theater mode · `?` shortcut help. Without playback control these send an approval request to the host instead. On the video itself: click = play/pause, double-click = fullscreen. In fullscreen the control bar fades out after 3 idle seconds and returns on any input.

## Security model

- **Identity** is the Supabase anonymous auth UID (`auth.uid()`); profile IDs are never client-invented once signed in.
- **Host authority is server-side.** `host_id` lives in the `rooms` table. Clients cannot elect themselves: `claim_host()` is a compare-and-swap that only succeeds when the current host's heartbeat (`last_seen`) is stale and the caller is the most senior online member. Graceful leave promotes immediately via `leave_room()`.
- **Settings/queue writes are RLS-gated** to `host_id` — a modified client calling `update rooms` is rejected by Postgres (0 rows affected). The one deliberate exception is `vote_queue_item()` (0009): any active member may toggle their own `{userId: true}` entry inside the item's `votes` jsonb — the function runs SECURITY DEFINER under a membership check, serializes on `FOR UPDATE`, and bumps `queue_version`, so guests can upvote but still cannot reorder, add, remove, or rewrite the queue.
- **Joining is validated server-side** by `join_room()`: room exists, optional bcrypt password matches, room not locked, caller not banned. Room codes are 6 chars from a 32-char alphabet (~1B combinations), generated with `gen_random_bytes`.
- **Moderation is server-side**: hosts ban/unban, mute (5 min), transfer hosting via `moderate_member()` / the RLS-guarded `host_id` update, and **delete any chat message** via `delete_chat_message()` (0007 — SECURITY DEFINER, host check mirrors `moderate_member`; chat RLS still has no DELETE policy, and deletions stream to members as realtime DELETE events). Banned users are ejected live via the `room_members` stream; muted users' chat/reactions are dropped by receivers and senders alike. **Watch history** (`rooms.watched`, host-written, last 30 videos) is shown as a "Watched" card with one-click replays — guests get queued into the approval path instead of playing directly.
- **Chat is durable and server-validated**: messages insert into `chat_messages` (RLS: active members only, sender must be you, mute enforced in the policy, 5 msgs/5s via trigger) and stream to everyone over the same channel — late joiners load history. **Per-message reactions** live in a `reactions jsonb` column and toggle through `toggle_chat_reaction()` (0008 — `FOR UPDATE` row lock serializes concurrent voters/togglers; no UPDATE policy means clients can't write reactions directly).
- **Playback control** travels over Realtime broadcasts for latency; receivers reject any `control`/`snapshot` whose `senderId` is not the Postgres host while playback is host-locked (or when guest control is unlocked, any member may control — they're already inside the authenticated room channel). Hosts can also **approve a guest's "ask for control" request**: the grant is a durable `granted_to uuid[]` row on `rooms` (RLS keeps writes host-only), receivers honour it while locked, and the host can revoke it from the roster. Realtime broadcasts are not cryptographically signed, so a determined attacker inside a room can forge *ephemeral* playback events from the host's ID; they still cannot change host, queue, permissions, grants, membership, or moderation state. Report issues that improve this (e.g. signed control tokens) via PRs.
- **Rate limits:** 5 room creations/minute/user (SQL), chat 5 msgs/5s (SQL trigger — modified clients can't bypass it), per-connection broadcast cap of 20 events/s (Supabase), plus per-identity budgets on both sides of the wire — chat client-side 5/5s + 500ms gap, reactions 6/3s, queue requests 6/min, votes 10/10s, control coalesced to ≤1 per 150ms outbound and ≤12/s inbound per sender, sync-request ≤1/3s, toast dedupe/gap.

## Project layout

```
supabase/migrations/        server-authoritative schema + RLS + RPCs (required)
src/
  sync/SyncEngine.ts     framework-agnostic playback sync (unit tested)
  player/YouTubePlayer.ts  YouTube IFrame adapter
  stores/room.ts         room state, transport wiring, host logic
  stores/session.ts      anonymous auth + profile
  lib/rooms-api.ts       typed wrappers around Postgres RPCs
  components/            UI
  voice/useVoice.ts      LiveKit wrapper (lazy-loaded)
supabase/functions/livekit-token/  edge function minting LiveKit JWTs
```
