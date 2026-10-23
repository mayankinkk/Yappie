import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Present-mode screenshare: host shares → own preview over the player,
 * the peer sees the presenter's stream, stopping clears both.
 *
 * Headless Chromium has no picker — --auto-select-desktop-capture-source
 * makes getDisplayMedia resolve to the whole screen without UI.
 *
 * Requirements: same .env.local keys as voice.spec.ts.
 */
function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();

const configured =
  !!process.env.VITE_SUPABASE_URL &&
  !!process.env.VITE_SUPABASE_ANON_KEY &&
  !!process.env.VITE_LIVEKIT_URL;

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  },
});

async function enterName(page: Page, name: string): Promise<void> {
  await page.fill("#name-input", name);
  await page.press("#name-input", "Enter");
}

async function videoWidth(page: Page, sel: string): Promise<number> {
  return page.evaluate((s) => {
    const el = document.querySelector<HTMLVideoElement>(s);
    return el?.videoWidth ?? 0;
  }, sel);
}

test.describe("screenshare", () => {
  test.skip(!configured, "needs .env.local Supabase keys + VITE_LIVEKIT_URL");

  test("host shares screen: local preview + peer view, stop clears both", async ({ browser }) => {
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const a = await aCtx.newPage();
    const b = await bCtx.newPage();

    try {
      await a.goto("/");
      await enterName(a, "ShareSana");
      await a.getByRole("button", { name: "Create a room" }).click();
      await expect(a.locator(".room-chip strong")).toBeVisible({ timeout: 30_000 });
      const code = (await a.locator(".room-chip strong").innerText()).trim();

      await b.goto("/");
      await enterName(b, "SeeSam");
      await b.fill("#code-input", code);
      await b.getByRole("button", { name: "Join", exact: true }).click();
      await expect(b.locator(".room-chip strong")).toHaveText(code, { timeout: 30_000 });

      for (const page of [a, b]) {
        await page.getByRole("button", { name: /Join voice/ }).click();
      }
      for (const page of [a, b]) {
        await expect(page.getByRole("button", { name: /Leave voice/ })).toBeVisible({
          timeout: 30_000,
        });
      }

      // --- Host starts presenting: local preview covers the player.
      await a.getByRole("button", { name: "Share screen" }).click();
      await expect(a.locator('.screenshare[data-self="self"]')).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => videoWidth(a, '.screenshare[data-self="self"] video'), { timeout: 15_000 })
        .toBeGreaterThan(0);

      // --- Peer sees the presenter's stream (subscribe + attach path).
      await expect(b.locator('.screenshare[data-self="peer"]')).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => videoWidth(b, '.screenshare[data-self="peer"] video'), { timeout: 20_000 })
        .toBeGreaterThan(0);

      // --- Stop from the overlay → unpublish clears both sides.
      await a.locator(".screenshare").getByRole("button", { name: "Stop sharing" }).click();
      await expect(a.locator(".screenshare")).toHaveCount(0);
      await expect(b.locator(".screenshare")).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });
});
