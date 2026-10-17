import * as Sentry from "@sentry/react";

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let enabled = false;

/**
 * Error monitoring. Opt-in via VITE_SENTRY_DSN — without it nothing is
 * initialized, no network calls are made, and the bundle path degrades to
 * a console error. Covers unhandled errors/rejections, React render errors
 * (ErrorBoundary), and adds release + routing context.
 */
export function initTelemetry(): void {
  if (!DSN) return;
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
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (enabled) Sentry.captureException(error, context ? { extra: context } : undefined);
  else console.error("Sofa error:", error);
}

export function setTelemetryUser(id: string | null): void {
  if (!enabled) return;
  Sentry.setUser(id ? { id } : null);
}
