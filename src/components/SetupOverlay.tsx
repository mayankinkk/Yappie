import { useState } from "react";
import {
  getSupabaseConfig,
  isSupabaseConfigured,
  saveSupabaseConfig,
  getLiveKitUrl,
  saveLiveKitUrl,
} from "../lib/supabase";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export default function SetupOverlay({ onClose, onSaved }: Props) {
  const cfg = getSupabaseConfig();
  const [url, setUrl] = useState(cfg.url.startsWith("YOUR_") ? "" : cfg.url);
  const [key, setKey] = useState(cfg.key.startsWith("YOUR_") ? "" : cfg.key);
  const [livekit, setLivekit] = useState(getLiveKitUrl() || "");
  const [error, setError] = useState("");
  const optional = !isSupabaseConfigured();

  function save() {
    const cleanUrl = url.trim().replace(/\/+$/, "");
    const cleanKey = key.trim();
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    } catch {
      setError("That doesn't look like a valid Project URL");
      return;
    }
    if (cleanKey.length < 20) {
      setError("That anon key looks too short");
      return;
    }
    saveSupabaseConfig(cleanUrl, cleanKey);
    if (livekit.trim()) saveLiveKitUrl(livekit.trim());
    onSaved();
  }

  return (
    <div className="overlay">
      <div className="overlay-card">
        <h2>Connect Supabase</h2>
        <p>Yappie syncs rooms through free Supabase Realtime. Setup takes about two minutes:</p>
        <ol>
          <li>
            Create a free project at{" "}
            <a href="https://supabase.com" target="_blank" rel="noreferrer">
              supabase.com
            </a>
          </li>
          <li>
            Open <strong>Project Settings → API</strong>
          </li>
          <li>
            Copy the <strong>Project URL</strong> and <strong>anon public key</strong> below
          </li>
        </ol>
        <input
          className="field mono"
          placeholder="https://xxxx.supabase.co"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
        />
        <input
          className="field mono"
          placeholder="anon public key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          spellCheck={false}
        />
        <input
          className="field mono"
          placeholder="LiveKit URL (optional, for voice)"
          value={livekit}
          onChange={(e) => setLivekit(e.target.value)}
          spellCheck={false}
        />
        {error && <p className="overlay-error">{error}</p>}
        <div className="overlay-actions">
          {optional ? (
            <button className="btn ghost" onClick={onClose}>
              Skip for now
            </button>
          ) : (
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="btn primary" onClick={save}>
            Save &amp; continue
          </button>
        </div>
        <p className="overlay-note">
          Saved in this browser only. The anon key is safe to ship — it's meant for client apps.
        </p>
      </div>
    </div>
  );
}
