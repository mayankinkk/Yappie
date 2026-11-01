import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Presence self-healing: when a guest's realtime socket dies the hard way
 * (severed connection — laptop lid, wifi drop), the guest client must
 * rebuild the channel on its own, and the rebuilt channel must be genuinely
 * functional: a presence track sent over it (typing indicator) has to
 * round-trip to the host, and both watch lists must still show two
 * watchers. No reload, no manual retry.
 *
 * The socket is severed with routeWebSocket's server-side close() rather
 * than context.setOffline, which does not reliably kill established
 * WebSocket connections.
 *
 * Requires .env.local Supabase keys + migrations (skips otherwise).
 */
function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();

const configured = !!process.env.VITE_SUPABASE_URL && !!process.env.VITE_SUPABASE_ANON_KEY;

async function enterName(page: Page, name: string): Promise<void> {
  await page.fill("#name-input", name);
  await page.press("#name-input", "Enter");
}

async function createRoom(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Create a room" }).click();
  await expect(page.locator(".room-chip strong")).toBeVisible({ timeout: 30_000 });
  return (await page.locator(".room-chip strong").innerText()).trim();
}

async function joinRoom(page: Page, code: string): Promise<void> {
  await page.fill("#code-input", code);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.locator(".room-chip strong")).toHaveText(code, { timeout: 30_000 });
}

test.describe("presence heal", () => {
  test.skip(!configured, "needs .env.local Supabase keys + migrations applied");

  test("guest presence round-trips after its realtime socket dies", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    // Pass every socket through to the real server, remembering BOTH the
    // page-side route (closing it surfaces a close event to page JS, which
    // is what a dead connection looks like from the app's side) and the
    // server-side handle for counting connections.
    const realtimeSockets: WebSocketRoute[] = [];
    const pageRoutes: WebSocketRoute[] = [];
    await guest.routeWebSocket("**/*", (route) => {
      const server = route.connectToServer();
      if (route.url().includes("/realtime/")) {
        realtimeSockets.push(server);
        pageRoutes.push(route);
      }
    });

    try {
      await host.goto("/");
      await enterName(host, "HealHost");
      const code = await createRoom(host);

      await guest.goto("/");
      await enterName(guest, "HealGuest");
      await joinRoom(guest, code);

      await expect(host.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
      await expect(guest.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
      expect(realtimeSockets.length).toBeGreaterThanOrEqual(1);

      // Sever the guest's realtime socket from the page side — page JS gets
      // a close event (like a real network death) and the server-side leg
      // is torn down too, dropping the ghost server-side.
      const before = realtimeSockets.length;
      await pageRoutes[pageRoutes.length - 1].close({ code: 1001, reason: "network drop" });

      // The guest client alone must open a replacement socket (its own
      // reconnect path — no reload, no retry click).
      await expect.poll(() => realtimeSockets.length, { timeout: 30_000 }).toBeGreaterThan(before);

      // The rebuilt channel must be genuinely functional: typing on the
      // guest sends a presence track over it, and that has to round-trip
      // to the host as a live typing indicator (it cannot appear from
      // stale pre-drop state — no typing flag was ever set before).
      await guest.fill('input.field[placeholder="Say something\u2026"]', "healing");
      await expect(host.locator(".typing-line")).toContainText("HealGuest is typing", {
        timeout: 15_000,
      });
      await guest.fill('input.field[placeholder="Say something\u2026"]', "");

      // Both rosters still correct after the whole cycle.
      await expect(host.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
      await expect(guest.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
});
