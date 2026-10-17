import { create } from "zustand";
import type { Profile } from "../types";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase";
import { nameHue, randomId } from "../lib/ids";
import { setTelemetryUser } from "../lib/telemetry";

const LS_PROFILE = "sofa.profile";

interface StoredProfile {
  id?: string;
  name: string;
  color: number;
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
  ensureIdentity(): Promise<Profile>;
  ensureAuthed(): Promise<Profile | null>;
}

let initPromise: Promise<Profile> | null = null;

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
      const name = stored?.name?.trim() || "";
      let id = stored?.id || "";
      let color = typeof stored?.color === "number" ? stored.color : nameHue(name || "Guest");

      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        if (supabase) {
          try {
            const authCall = supabase.auth.signInAnonymously().catch(() => null);
            const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500));
            const result = await Promise.race([authCall, timeout]);
            const user = result?.data?.user;
            if (user) {
              id = user.id;
              if (!name) color = nameHue(id);
            }
          } catch {
            /* offline or auth disabled — fall back to local id */
          }
        }
      }
      if (!id) id = randomId();

      const profile: Profile = { id, name: name || "Guest", color };
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
    };
    persist(profile);
    set({ profile });
  },

  async ensureIdentity(): Promise<Profile> {
    const existing = get().profile;
    if (existing) return existing;
    return get().init();
  },

  ensureAuthed,
}));
