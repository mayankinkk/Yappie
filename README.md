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
| `npm run preview` | serve the production build |

## Deploy

Static hosting, no server needed:

- **Vercel**: `vercel deploy` (config in `vercel.json`)
- **Netlify**: `netlify deploy --prod` (config in `netlify.toml`)
- **GitHub Pages**: `npm run build` then publish `dist/`

Set the env vars in your host's dashboard (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_LIVEKIT_URL`) so first-time visitors skip the setup overlay.

## How sync works

Each room is a Supabase Realtime channel. Playback state (video id, timestamp, playing) is broadcast on every play/pause/seek; every other client applies it, advancing the timestamp by elapsed time for late arrivals. Clients that drift more than 0.75s off the shared timeline re-seek every 5s. The host owns the room snapshot (queue, permissions, host identity) and re-broadcasts it on change; if the host leaves, the longest-present member takes over deterministically.

## Project layout

```
src/
  sync/SyncEngine.ts     framework-agnostic playback sync (unit tested)
  player/YouTubePlayer.ts  YouTube IFrame adapter
  stores/room.ts         room state, transport wiring, host logic
  stores/session.ts      anonymous auth + profile
  components/            UI
  voice/useVoice.ts      LiveKit wrapper (lazy-loaded)
supabase/functions/livekit-token/  edge function minting LiveKit JWTs
```
