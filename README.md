# Sofa

Watch YouTube together, in perfect sync. Rooms with synced playback, chat, reactions, a shared queue, and optional voice chat.

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
3. Anonymous sign-in must be enabled (it is by default under **Authentication → Providers → Anonymous**)
4. **Apply the database migration** — paste [`supabase/migrations/0001_server_authority.sql`](supabase/migrations/0001_server_authority.sql) into the SQL editor (or `supabase db push` if you use the CLI). The app does not work without it: rooms, membership, and host authority live in Postgres.

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
| `npm test` | unit tests for the sync engine |
| `npm run lint` | ESLint over `src/` |
| `npm run preview` | serve the production build |

## Deploy

Static hosting, no server needed:

- **Vercel**: `vercel deploy` (config in `vercel.json`)
- **Netlify**: `netlify deploy --prod` (config in `netlify.toml`)
- **GitHub Pages**: `npm run build` then publish `dist/`

Set the env vars in your host's dashboard (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_LIVEKIT_URL`) so first-time visitors skip the setup overlay.

## How sync works

Each room is a Supabase Realtime channel. Playback state (video id, timestamp, playing) is broadcast on every play/pause/seek; every other client applies it, advancing the timestamp by elapsed time for late arrivals. Clients that drift more than 0.75s off the shared timeline re-seek every 5s. Durable room state (host, permissions, queue, membership) lives in Postgres — see below.

## Security model

- **Identity** is the Supabase anonymous auth UID (`auth.uid()`); profile IDs are never client-invented once signed in.
- **Host authority is server-side.** `host_id` lives in the `rooms` table. Clients cannot elect themselves: `claim_host()` is a compare-and-swap that only succeeds when the current host's heartbeat (`last_seen`) is stale and the caller is the most senior online member. Graceful leave promotes immediately via `leave_room()`.
- **Settings/queue writes are RLS-gated** to `host_id` — a modified client calling `update rooms` is rejected by Postgres (0 rows affected).
- **Joining is validated server-side** by `join_room()`: room exists, optional bcrypt password matches, room not locked, caller not banned. Room codes are 6 chars from a 32-char alphabet (~1B combinations), generated with `gen_random_bytes`.
- **Moderation is server-side**: hosts ban/unban, mute (5 min), and transfer hosting via `moderate_member()` / the RLS-guarded `host_id` update. Banned users are ejected live via the `room_members` stream; muted users' chat/reactions are dropped by receivers and senders alike.
- **Playback control** travels over Realtime broadcasts for latency; receivers reject any `control`/`snapshot` whose `senderId` is not the Postgres host while playback is host-locked (or when guest control is unlocked, any member may control — they're already inside the authenticated room channel). Realtime broadcasts are not cryptographically signed, so a determined attacker inside a room can forge *ephemeral* playback events from the host's ID; they still cannot change host, queue, permissions, membership, or moderation state. Report issues that improve this (e.g. signed control tokens) via PRs.
- **Rate limits:** 5 room creations/minute/user (SQL), per-connection broadcast cap of 20 events/s (Supabase), plus per-identity budgets on both sides of the wire — chat 5/5s, reactions 6-8/3s, queue requests 6/min, control coalesced to ≤1 per 150ms outbound and ≤12/s inbound per sender, sync-request ≤1/3s, toast dedupe/gap. Server-side chat limits land with chat persistence.

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
