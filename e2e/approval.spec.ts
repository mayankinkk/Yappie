import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Room approval gate (0017): with "Let me approve people before they join"
 * on, a stranger's join_room call is refused with approval_required — they
 * see the waiting card instead of the room, the host gets a live join
 * request, and admitting them must land them in the room with both rosters
 * showing two watchers.
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

test.describe("approval gate", () => {
  test.skip(!configured, "needs .env.local Supabase keys + migrations applied");

  test("stranger waits, host admits, stranger lands in the room", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    try {
      // Host turns the approval gate on via Room Settings.
      await host.goto("/");
      await enterName(host, "GateHost");
      const code = await createRoom(host);
      await host.getByRole("button", { name: "Room settings" }).click();
      await host.getByLabel("Let me approve people before they join").check();
      await host.getByRole("button", { name: "Save" }).click();
      await expect(host.locator(".overlay")).toHaveCount(0, { timeout: 10_000 });

      // Guest's join is refused by the server — they must land on the
      // waiting card, NOT in the room.
      await guest.goto("/");
      await enterName(guest, "GateGuest");
      await guest.fill("#code-input", code);
      await guest.getByRole("button", { name: "Join", exact: true }).click();
      await expect(guest.locator(".approval-wait")).toBeVisible({ timeout: 30_000 });
      await expect(guest.locator(".room-chip")).toHaveCount(0);
      await expect(host.locator(".watcher-chip")).toHaveCount(1, { timeout: 15_000 });

      // The host sees the live request and admits it.
      await expect(host.locator(".join-request")).toContainText("GateGuest", { timeout: 15_000 });
      await host.locator(".cr-btn.approve").click();

      // Admit runs approve_join server-side, broadcasts join-approval, and
      // the guest auto-rejoins — into the room, with both rosters at two.
      await expect(guest.locator(".room-chip strong")).toHaveText(code, { timeout: 30_000 });
      await expect(guest.locator(".approval-wait")).toHaveCount(0, { timeout: 15_000 });
      await expect(host.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
      await expect(guest.locator(".watcher-chip")).toHaveCount(2, { timeout: 30_000 });
      await expect(host.locator(".join-requests")).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
});
