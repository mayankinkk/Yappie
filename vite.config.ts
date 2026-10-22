import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // The only >500kB chunk is the lazily-loaded livekit vendor (fetched on
    // Join voice, never on first load) — app/react/vendor are all well under.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Keep heavy vendors out of the app chunk so first load stays small
        // and a livekit-only change doesn't invalidate react/sentry caches.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (/node_modules\/(@livekit|livekit-client)\//.test(id)) return "livekit";
          if (/node_modules\/(@sentry)\//.test(id)) return "sentry";
          return "vendor";
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
