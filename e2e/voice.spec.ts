import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Voice delivery verification — "can the other person actually hear me?"
 *
 * Uses Chrome's fake microphone in two isolated contexts. Asserts each side
 * ends up with a live, playing <audio> element fed by the remote track —
 * the real publish → subscribe → playback path. (The UI's "speaking" avatar
 * only reflects server-side audio levels and can be true while a listener
 * hears nothing.)
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
    // LiveKit attaches remote audio to elements that are never appended to
    // the DOM, so track them as they are created.
    const trackAudio = () => {
      const orig = document.createElement.bind(document);
      document.createElement = (tag: string, ...rest: unknown[]) => {
        const el = orig(tag, ...(rest as []));
        if (String(tag).toLowerCase() === "audio") {
          ((window as unknown as { __lkAudios?: HTMLAudioElement[] }).__lkAudios ??= []).push(
            el as HTMLAudioElement,
          );
        }
        return el;
      };
    };
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    await aCtx.addInitScript(trackAudio);
    await bCtx.addInitScript(trackAudio);
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

      // --- Playback: each side must have an attached <audio> element that
      //     is actually running. Speaking indicators are server-side levels
      //     and are unreliable with fake capture devices; an advancing
      //     currentTime is the real proof that received audio is played.
      for (const page of [a, b]) {
        await expect
          .poll(
            async () =>
              page.evaluate(() =>
                (
                  (window as unknown as { __lkAudios?: HTMLAudioElement[] }).__lkAudios ?? []
                ).some((el) => !el.paused && el.currentTime > 0),
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
      }

      // --- Cameras: each side turns the webcam on (the same fake device
      //     flag supplies a moving test pattern). With both on, each side
      //     must render 2 tiles (self + remote) and the REMOTE tile must
      //     actually decode frames. (Don't filter on `muted` here — LiveKit
      //     force-mutes video-only streams inside attach() so autoplay
      //     always works; camera tracks carry no audio anyway.)
      for (const page of [a, b]) {
        await page.getByRole("button", { name: "Turn camera on" }).click();
      }
      for (const page of [a, b]) {
        await expect(page.locator(".video-strip .video-tile")).toHaveCount(2, {
          timeout: 30_000,
        });
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const el = document.querySelector<HTMLVideoElement>(
                  '.video-strip .video-tile[data-self="peer"] video',
                );
                return !!el && el.videoWidth > 0;
              }),
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
