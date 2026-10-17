import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ENV_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const ENV_LIVEKIT = import.meta.env.VITE_LIVEKIT_URL as string | undefined;
const LS_KEY = "sofa.supabase";

let client: SupabaseClient | null = null;

function saved(): { url?: string; key?: string } {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "null") || {};
  } catch {
    return {};
  }
}

export function getSupabaseConfig(): { url: string; key: string } {
  const s = saved();
  return {
    url: (s.url || ENV_URL || "YOUR_SUPABASE_URL").replace(/\/+$/, ""),
    key: s.key || ENV_KEY || "YOUR_SUPABASE_ANON_KEY",
  };
}

export function isSupabaseConfigured(): boolean {
  const { url, key } = getSupabaseConfig();
  return /^https?:\/\//.test(url) && !url.startsWith("YOUR_") && key.length > 20 && !key.startsWith("YOUR_");
}

export function saveSupabaseConfig(url: string, key: string): void {
  localStorage.setItem(LS_KEY, JSON.stringify({ url: url.replace(/\/+$/, ""), key }));
}

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    const { url, key } = getSupabaseConfig();
    client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return client;
}

export function getLiveKitUrl(): string | null {
  const s = saved() as { livekit?: string };
  return s.livekit || ENV_LIVEKIT || null;
}

export function saveLiveKitUrl(url: string): void {
  localStorage.setItem(LS_KEY, JSON.stringify({ ...saved(), livekit: url.replace(/\/+$/, "") }));
}

export function isVoiceConfigured(): boolean {
  return isSupabaseConfigured() && !!getLiveKitUrl();
}

export async function fetchLiveKitToken(room: string, name: string): Promise<{ token: string; url: string } | null> {
  const supabase = getSupabase();
  const url = getLiveKitUrl();
  if (!supabase || !url) return null;
  try {
    const { data, error } = await supabase.functions.invoke("livekit-token", {
      body: { room, name },
    });
    if (error || !data?.token) return null;
    return { token: data.token as string, url };
  } catch {
    return null;
  }
}
