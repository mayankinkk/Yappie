import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Voice delivery verification — "can the other person actually hear me?"
 *
 * Uses Chrome's fake microphone in two isolated contexts. A remote
 * `.speaking` indicator only turns true when audio published by one
 * client arrives at the other through the LiveKit SFU, so asserting it
 * proves the full publish → subscribe → receive path.
 *
 * Requirements (skips with a clear message otherwise):
 *  - .env.local with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_LIVEKIT_URL
 *  - anonymous auth enabled in Supabase
 *  - livekit-token edge function deployed with LIVEKIT_API_KEY / _SECRET
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
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

async function enterName(page: Page, name: string): Promise<void> {
  await page.fill("#name-input", name);
  await page.press("#name-input", "Enter");
}

test.describe("voice", () => {
  test.skip(!configured, "needs .env.local Supabase keys + VITE_LIVEKIT_URL");

  test("two clients join voice and audio reaches the other side", async ({ browser }) => {
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const a = await aCtx.newPage();
    const b = await bCtx.newPage();

    try {
      // --- Host creates a room
      await a.goto("/");
      await enterName(a, "VoiceAlice");
      await a.getByRole("button", { name: "Create a room" }).click();
      await expect(a.locator(".room-chip strong")).toBeVisible({ timeout: 30_000 });
      const code = (await a.locator(".room-chip strong").innerText()).trim();

      // --- Guest joins the same room
      await b.goto("/");
      await enterName(b, "VoiceBob");
      await b.fill("#code-input", code);
      await b.getByRole("button", { name: "Join", exact: true }).click();
      await expect(b.locator(".room-chip strong")).toHaveText(code, { timeout: 30_000 });

      // --- Both enter the voice room, then each should see two people
      for (const page of [a, b]) {
        await page.getByRole("button", { name: /Join voice/ }).click();
      }
      for (const page of [a, b]) {
        await expect(page.locator(".voice-people .voice-person")).toHaveCount(2, {
          timeout: 30_000,
        });
        await expect(page.locator(".voice-error")).toHaveCount(0);
      }

      // --- Cross-delivery: each side must see the REMOTE avatar speaking.
      //     Local list order is [local, remote], so nth-child(2) is remote.
      //     Remote speaking is derived from received audio levels — it can
      //     only turn true if the other client's mic audio actually arrived.
      await expect(a.locator(".voice-people .voice-person:nth-child(2).speaking")).toBeVisible({
        timeout: 30_000,
      });
      await expect(b.locator(".voice-people .voice-person:nth-child(2).speaking")).toBeVisible({
        timeout: 30_000,
      });

      // --- Playback: an attached <audio> element must actually be running.
      //     Speaking indicators come from server-side levels and can be true
      //     even when nothing plays locally; an advancing currentTime is the
      //     real proof that the listener can hear anything.
      for (const page of [a, b]) {
        await expect
          .poll(
            async () =>
              page.evaluate(() =>
                [...document.querySelectorAll("audio")].some(
                  (el) => !el.paused && el.currentTime > 0,
                ),
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
      }
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });
});
