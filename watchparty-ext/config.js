/**
 * Single source of truth for the relay endpoint.
 *
 * Loaded before content.js by the manifest and before popup.js by popup.html,
 * so both sides read the same value and there is one place to change it.
 *
 * `ws://localhost` is fine for local dev (Chrome treats localhost as a secure
 * context). Any *remote* relay must be `wss://` — browsers block a plain `ws://`
 * connection from a page loaded over `https://`, which is most of the web.
 */
globalThis.WP_CONFIG = {
  // TODO: replace with your deployed relay before publishing.
  // e.g. "wss://relay.example.com"
  WS_RELAY_URL: "ws://localhost:8787",
};
