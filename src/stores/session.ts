import { create } from "zustand";
import type { Profile } from "../types";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase";
import { nameHue, randomId } from "../lib/ids";
import { setTelemetryUser } from "../lib/telemetry";

const LS_PROFILE = "yappie.profile";

/** Emoji avatar shown instead of initials; empty = initials fallback. */
export const AVATAR_EMOJIS = [
  "🍿", "🎬", "🎧", "🎮", "🐶", "🐱", "🦊", "🐼",
  "👽", "🤖", "🔥", "✨", "🌙", "🌈", "🍕", "☕",
];

interface StoredProfile {
  id?: string;
  name: string;
  color: number;
  avatar?: string;
}

function readStored(): StoredProfile | null {
  try {
    return JSON.parse(localStorage.getItem(LS_PROFILE) || "null");
  } catch {
    return null;
  }
}

function persist(profile: Profile): void {
  localStorage.setItem(LS_PROFILE, JSON.stringify(profile));
}

interface SessionState {
  profile: Profile | null;
  initialized: boolean;
  init(): Promise<Profile>;
  setName(name: string): void;
  setAvatar(avatar: string): void;
  signInWithGoogle(): Promise<string | null>;
  ensureIdentity(): Promise<Profile>;
  ensureAuthed(): Promise<Profile | null>;
}

let initPromise: Promise<Profile> | null = null;

/** Fire-and-forget: persist the profile to user_profiles (own-row RLS). */
function upsertServerProfile(profile: Profile): void {
  const supabase = getSupabase();
  if (!supabase || !profile.id) return;
  void supabase
    .from("user_profiles")
    .upsert(
      {
        user_id: profile.id,
        name: profile.name,
        avatar: profile.avatar || "",
        color: profile.color,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .then(({ error }: { error: { message?: string } | null }) => {
      if (error) console.debug("[profile] upsert failed:", error.message);
    });
}

/**
 * Guarantees an authenticated Supabase session and that profile.id === auth.uid().
 * Server-side authorization (host, moderation, membership) keys off auth.uid(),
 * so room actions must call this first. Returns null when auth is unavailable.
 */
export async function ensureAuthed(): Promise<Profile | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  let uid: string | null;
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user?.id) {
      uid = data.session.user.id;
    } else {
      const res = await supabase.auth.signInAnonymously();
      uid = res.data.user?.id ?? null;
    }
  } catch {
    return null;
  }
  if (!uid) return null;

  const current = useSession.getState().profile;
  if (current?.id === uid) return current;
  const profile: Profile = {
    id: uid,
    name: current?.name && current.name !== "Guest" ? current.name : "Guest",
    color: current?.color ?? nameHue(uid),
    avatar: current?.avatar || "",
  };
  persist(profile);
  useSession.setState({ profile });
  return profile;
}

export const useSession = create<SessionState>((set, get) => ({
  profile: null,
  initialized: false,

  init(): Promise<Profile> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const stored = readStored();
      let name = stored?.name?.trim() || "";
      let id = stored?.id || "";
      let color = typeof stored?.color === "number" ? stored.color : nameHue(name || "Guest");
      let avatar = typeof stored?.avatar === "string" ? stored.avatar : "";

      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        if (supabase) {
          try {
            // Never clobber an existing session (e.g. Google sign-in) with a
            // fresh anonymous one — only sign in anonymously when we're nobody.
            const existing = await supabase.auth.getSession();
            let user = existing.data.session?.user ?? null;
            if (!user) {
              const authCall = supabase.auth.signInAnonymously().catch(() => null);
              const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500));
              const result = await Promise.race([authCall, timeout]);
              user = result?.data?.user ?? null;
            }
            if (user) {
              id = user.id;
              const meta = user.user_metadata as { full_name?: unknown; name?: unknown } | undefined;
              const metaName = String(meta?.full_name || meta?.name || "").trim().slice(0, 24);
              if (metaName && (!name || name === "Guest")) name = metaName;
              if (!name) color = nameHue(id);
              // Server profile fills the blanks this device hasn't set yet.
              try {
                const { data: row } = await supabase
                  .from("user_profiles")
                  .select("name, avatar, color")
                  .eq("user_id", id)
                  .maybeSingle();
                if (row) {
                  const serverName = String(row.name || "").trim().slice(0, 24);
                  if (serverName && (!name || name === "Guest")) name = serverName;
                  if (typeof row.avatar === "string" && row.avatar && !avatar) avatar = row.avatar;
                  if (typeof row.color === "number" && (!stored || stored.color === undefined)) color = row.color;
                }
              } catch {
                /* profile row not readable yet — local values stand */
              }
            }
          } catch {
            /* offline or auth disabled — fall back to local id */
          }
        }
      }
      if (!id) id = randomId();

      const profile: Profile = { id, name: name || "Guest", color, avatar };
      persist(profile);
      set({ profile, initialized: true });
      setTelemetryUser(id);
      return profile;
    })();
    return initPromise;
  },

  setName(name: string): void {
    const current = get().profile;
    const trimmed = name.trim() || "Guest";
    const profile: Profile = {
      id: current?.id || randomId(),
      name: trimmed,
      color: current?.color ?? nameHue(trimmed),
      avatar: current?.avatar || "",
    };
    persist(profile);
    set({ profile });
    upsertServerProfile(profile);
  },

  setAvatar(avatar: string): void {
    const current = get().profile;
    const profile: Profile = {
      id: current?.id || randomId(),
      name: current?.name || "Guest",
      color: current?.color ?? nameHue(current?.name || "Guest"),
      avatar,
    };
    persist(profile);
    set({ profile });
    upsertServerProfile(profile);
  },

  async signInWithGoogle(): Promise<string | null> {
    const supabase = getSupabase();
    if (!supabase) return "Connect Supabase in settings first";
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) return "Google sign-in isn't enabled — turn it on in Supabase Auth settings";
      return null;
    } catch {
      return "Couldn't reach the sign-in service";
    }
  },

  async ensureIdentity(): Promise<Profile> {
    const existing = get().profile;
    if (existing) return existing;
    return get().init();
  },

  ensureAuthed,
}));
