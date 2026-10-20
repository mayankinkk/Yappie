import { createClient } from "npm:@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const apiKey = Deno.env.get("LIVEKIT_API_KEY");
    const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    if (!apiKey || !apiSecret) return json({ error: "voice not configured" }, 503);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "missing auth" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return json({ error: "invalid auth" }, 401);

    const { room, name } = await req.json();
    if (typeof room !== "string" || !/^[A-Z0-9]{6}$/.test(room)) {
      return json({ error: "invalid room" }, 400);
    }
    const displayName = typeof name === "string" ? name.slice(0, 24) : "Guest";

    const at = new AccessToken(apiKey, apiSecret, {
      identity: data.user.id,
      name: displayName,
      ttl: "2h",
    });
    at.addGrant({
      roomJoin: true,
      room: `yappie-${room}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });

    return json({ token: await at.toJwt() });
  } catch {
    return json({ error: "token error" }, 500);
  }
});
