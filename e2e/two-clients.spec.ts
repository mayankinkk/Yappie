import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Two-real-client verification — the sync app's core promise.
 *
 * Requirements (tests skip with a clear message otherwise):
 *  - .env.local with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 *  - anonymous auth enabled in Supabase
 *  - migrations 0001 + 0002 applied
 *
 * Each test runs two isolated browser contexts (separate storage → separate
 * anonymous users), exactly like two friends on two laptops.
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

test.describe("two clients", () => {
  test.skip(!configured, "needs .env.local Supabase keys + migrations applied");

  test("create, join, presence, chat, host lock, queue sync", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    try {
      // --- Host creates a room
      await host.goto("/");
      await enterName(host, "HostAlice");
      const code = await createRoom(host);
      expect(code).toMatch(/^[A-Z0-9]{6}$/);

      // --- Guest joins with the code
      await guest.goto("/");
      await enterName(guest, "GuestBob");
      await joinRoom(guest, code);

      // --- Both see each other (presence round-trip)
      await expect(host.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
      await expect(guest.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
      await expect(host.locator(".watcher-chip", { hasText: "GuestBob" })).toBeVisible();

      // --- Chat: guest → host over the database stream
      await guest.locator(".chat-form input").fill("hello from guest");
      await guest.getByRole("button", { name: "Send" }).click();
      await expect(
        host.locator(".msg-text", { hasText: "hello from guest" }),
      ).toBeVisible({ timeout: 20_000 });

      // --- Chat: host → guest
      await host.locator(".chat-form input").fill("hi bob");
      await host.getByRole("button", { name: "Send" }).click();
      await expect(guest.locator(".msg-text", { hasText: "hi bob" })).toBeVisible({
        timeout: 20_000,
      });

      // --- Host locks playback → guest sees the host-locked badge (server state)
      await host.getByRole("button", { name: "Lock playback" }).click();
      await expect(guest.locator(".badge.locked-badge", { hasText: "Host-locked" })).toBeVisible({
        timeout: 20_000,
      });

      // --- Host unlocks again so the queue steps below work for anyone
      await host.getByRole("button", { name: "Allow guest control" }).click();

      // --- Queue: host adds → appears on both (Postgres row → rooms stream)
      await host.locator(".queue-add input").fill("https://youtu.be/dQw4w9WgXcQ");
      await host.locator(".queue-add input").press("Enter");
      await expect(host.locator(".queue-item")).toHaveCount(1, { timeout: 20_000 });
      await expect(guest.locator(".queue-item")).toHaveCount(1, { timeout: 20_000 });

      // --- Guest adds directly (server-authoritative add_queue_item) → both see it
      await guest.locator(".queue-add input").fill("https://youtu.be/jNQXAC9IVRw");
      await guest.locator(".queue-add input").press("Enter");
      await expect(guest.locator(".toast", { hasText: "Added to queue" })).toBeVisible();
      await expect(host.locator(".queue-item")).toHaveCount(2, { timeout: 20_000 });
      await expect(guest.locator(".queue-item")).toHaveCount(2, { timeout: 20_000 });

      // --- Invite-only lock: host locks room, fresh context can't join
      await host.getByRole("button", { name: "Lock room" }).click();
      await expect(host.getByRole("button", { name: "Room locked", exact: true })).toBeVisible();
      const outsiderCtx = await browser.newContext();
      const outsider = await outsiderCtx.newPage();
      try {
        await outsider.goto("/");
        await enterName(outsider, "Outsider");
        await outsider.fill("#code-input", code);
        await outsider.getByRole("button", { name: "Join", exact: true }).click();
        await expect(outsider.locator(".toast-error", { hasText: "locked" })).toBeVisible({
          timeout: 20_000,
        });
        await expect(outsider.locator(".room-chip")).toHaveCount(0);
      } finally {
        await outsiderCtx.close();
      }
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });

  test("password-protected room rejects wrong password, accepts right one", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    try {
      await host.goto("/");
      await enterName(host, "PwHost");
      await host.getByLabel("Protect the room with a password").check();
      await host.locator('input[placeholder="Room password"]').fill("sesame");
      const code = await createRoom(host);

      await guest.goto("/");
      await enterName(guest, "PwGuest");
      await guest.fill("#code-input", code);
      await guest.getByRole("button", { name: "Join", exact: true }).click();

      // Server demands a password before revealing anything about the room
      await expect(guest.locator('input[placeholder="Password for this room"]')).toBeVisible({
        timeout: 20_000,
      });
      await expect(guest.locator(".room-chip")).toHaveCount(0);

      // Wrong password → inline error, still outside the room
      await guest.locator('input[placeholder="Password for this room"]').fill("wrong");
      await guest.getByRole("button", { name: "Join", exact: true }).click();
      await expect(guest.locator(".field-error", { hasText: "Wrong password" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(guest.locator(".room-chip")).toHaveCount(0);

      // Right password → in
      await guest.locator('input[placeholder="Password for this room"]').fill("sesame");
      await guest.getByRole("button", { name: "Join", exact: true }).click();
      await expect(guest.locator(".room-chip strong")).toHaveText(code, { timeout: 30_000 });
      await expect(guest.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
});
