import * as Sentry from "@sentry/react";
import { getSupabase } from "./supabase";

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let enabled = false;
let fallbackInited = false;
const seen = new Set<string>();
let reported = 0;
const REPORT_CAP = 10;

/**
 * Error monitoring. With VITE_SENTRY_DSN: Sentry (unhandled errors,
 * rejections, React render errors via ErrorBoundary, release + routing
 * context). Without a DSN: a zero-config fallback that console.errors and
 * inserts into the client_errors table (RLS insert-only, deduped and capped
 * at 10 per session) so production problems are still observable.
 */
export function initTelemetry(): void {
  if (DSN) {
    Sentry.init({
      dsn: DSN,
      environment: import.meta.env.MODE,
      release: `sofa@${import.meta.env.npm_package_version || "1.0.0"}`,
      tracesSampleRate: 0.1,
      ignoreErrors: [
        // Supabase realtime flaps and YouTube embed quirks are expected noise
        "ResizeObserver loop",
        "Non-Error promise rejection",
      ],
    });
    enabled = true;
    return;
  }
  if (fallbackInited || typeof window === "undefined") return;
  fallbackInited = true;
  window.addEventListener("error", (e) => {
    reportFallback(e.message, e.error instanceof Error ? e.error.stack : undefined, e.filename ? `${e.filename}:${e.lineno}` : "error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    reportFallback(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined, "unhandledrejection");
  });
}

function reportFallback(message: string, stack?: string, source?: string): void {
  const key = (message || "").slice(0, 300);
  if (!key || seen.has(key) || reported >= REPORT_CAP) return;
  seen.add(key);
  reported += 1;
  const supabase = getSupabase();
  if (!supabase) return;
  const room = new URLSearchParams(location.search).get("room");
  void supabase.from("client_errors").insert({
    message: key,
    stack: (stack || "").slice(0, 2000),
    source: source || null,
    url: location.href.slice(0, 500),
    room_code: room,
    user_agent: navigator.userAgent.slice(0, 400),
  });
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (enabled) {
    Sentry.captureException(error, context ? { extra: context } : undefined);
    return;
  }
  console.error("Sofa error:", error);
  const err = error instanceof Error ? error : null;
  reportFallback(err?.message || String(error), err?.stack, context ? JSON.stringify(context).slice(0, 300) : "captureError");
}

export function setTelemetryUser(id: string | null): void {
  if (!enabled) return;
  Sentry.setUser(id ? { id } : null);
}
