import { test, expect, devices, type Page } from "@playwright/test";
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
        await expect(
          page.locator(".video-strip:not(.video-strip-float) .video-tile"),
        ).toHaveCount(2, {
          timeout: 30_000,
        });
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const el = document.querySelector<HTMLVideoElement>(
                  '.video-strip:not(.video-strip-float) .video-tile[data-self="peer"] video',
                );
                return !!el && el.videoWidth > 0;
              }),
            { timeout: 30_000 },
          )
          .toBe(true);
        // The desktop stage is a fixed-height flex column; a strip without
        // flex:none collapses to ~1px while still decoding frames. Assert a
        // real rendered height so this can't regress silently.
        const box = await page
          .locator('.video-strip:not(.video-strip-float) .video-tile[data-self="peer"]')
          .boundingBox();
        expect(box?.height ?? 0).toBeGreaterThan(50);
        // Product rule: tile video must stay un-mirrored (scaleX(-1) applied).
        const tf = await page.evaluate(() => {
          const el = document.querySelector(".video-strip:not(.video-strip-float) video");
          return el ? getComputedStyle(el).transform : "none";
        });
        expect(tf).not.toBe("none");
      }

      // --- Fullscreen float: the strip renders as a floating overlay inside
      //     .cinema (visible only via :fullscreen), defaults to the right
      //     side, drags freely, and snaps to the nearest edge on release.
      await a.evaluate(() => document.querySelector(".cinema")?.requestFullscreen());
      const floatStrip = a.locator(".video-strip-float");
      await expect(floatStrip).toBeVisible({ timeout: 10_000 });
      // Fullscreen = peers only; the self-view lives on the stage strip.
      await expect(a.locator('.video-strip-float .video-tile[data-self="self"]')).toHaveCount(0);
      await expect(a.locator('.video-strip-float .video-tile[data-self="peer"]')).toHaveCount(1);
      const fsBox = await floatStrip.boundingBox();
      expect(fsBox?.height ?? 0).toBeGreaterThan(50);
      const vp = a.viewportSize()!;
      expect(fsBox!.x).toBeGreaterThan(vp.width / 2); // default: right half

      // The player must FILL the fullscreen height: the desktop strip-budget
      // max-height has the same specificity as the fullscreen override, so
      // source order decides — a black void under the controls means the
      // cap leaked into fullscreen again.
      const pw = await a.locator(".player-wrap").boundingBox();
      expect(pw?.height ?? 0).toBeGreaterThan(vp.height * 0.7);

      // Drag toward the left → release snaps it flush to the left edge.
      await a.mouse.move(fsBox!.x + fsBox!.width / 2, fsBox!.y + fsBox!.height / 2);
      await a.mouse.down();
      await a.mouse.move(vp.width * 0.15, fsBox!.y + fsBox!.height / 2, { steps: 12 });
      await a.mouse.up();
      await expect
        .poll(async () => (await floatStrip.boundingBox())?.x ?? 9999, { timeout: 5_000 })
        .toBeLessThan(30);

      // Exit fullscreen → floating copy disappears, stage strip shows all
      // again (self + peer).
      await a.evaluate(() => document.exitFullscreen());
      await expect(floatStrip).toBeHidden();
      await expect(a.locator(".video-strip:not(.video-strip-float)")).toBeVisible();
      await expect(
        a.locator('.video-strip:not(.video-strip-float) .video-tile[data-self="self"]'),
      ).toHaveCount(1);
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  // Android path lock: needsNativeYoutubeControls() must gate on the
  // Fullscreen API, not screen.orientation.lock — coarse-pointer devices
  // WITH requestFullscreen keep our custom controls, and therefore our
  // fullscreen with the floating peer-camera strip. (Gating on lock pushed
  // lock-less Android browsers onto YouTube's in-iframe fullscreen, where
  // the float can never appear.)
  test("android-like: custom controls and floating peer camera in fullscreen", async ({
    browser,
  }) => {
    const mCtx = await browser.newContext({ ...devices["Pixel 7"] });
    const dCtx = await browser.newContext();
    const m = await mCtx.newPage();
    const d = await dCtx.newPage();

    try {
      await m.goto("/");
      // Sanity: the emulation must present a coarse pointer or this test
      // would silently prove the desktop path instead of the Android one.
      expect(
        await m.evaluate(() => window.matchMedia?.("(pointer: coarse)").matches ?? false),
      ).toBe(true);

      await enterName(m, "DroidMia");
      await m.getByRole("button", { name: "Create a room" }).click();
      await expect(m.locator(".room-chip strong")).toBeVisible({ timeout: 30_000 });
      const code = (await m.locator(".room-chip strong").innerText()).trim();

      await d.goto("/");
      await enterName(d, "DeskPete");
      await d.fill("#code-input", code);
      await d.getByRole("button", { name: "Join", exact: true }).click();
      await expect(d.locator(".room-chip strong")).toHaveText(code, { timeout: 30_000 });

      // Custom controls, not the YouTube-native handover.
      await expect(m.locator(".cinema")).not.toHaveClass(/yt-native/);

      for (const page of [m, d]) {
        await page.getByRole("button", { name: /Join voice/ }).click();
        await page.getByRole("button", { name: "Turn camera on" }).click();
      }
      await expect(m.locator('.video-strip:not(.video-strip-float) .video-tile')).toHaveCount(2, {
        timeout: 30_000,
      });

      // Enter fullscreen the same way the app does, then the floating strip
      // must appear showing peers only — the Android equivalent of the
      // desktop fullscreen block above.
      await m.evaluate(() => document.querySelector(".cinema")?.requestFullscreen());
      const float = m.locator(".video-strip-float");
      await expect(float).toBeVisible({ timeout: 10_000 });
      await expect(m.locator('.video-strip-float .video-tile[data-self="self"]')).toHaveCount(0);
      await expect(m.locator('.video-strip-float .video-tile[data-self="peer"]')).toHaveCount(1);
      const box = await float.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThan(40);

      await m.evaluate(() => document.exitFullscreen());
      await expect(float).toBeHidden();
      await expect(
        m.locator('.video-strip:not(.video-strip-float) .video-tile[data-self="self"]'),
      ).toHaveCount(1);
    } finally {
      await mCtx.close();
      await dCtx.close();
    }
  });

  // Idle auto-leave: a hidden page for IDLE ms → Stay/Leave-now prompt →
  // GRACE ms later the seat drops (LiveKit bills muted seats too). The
  // window.__YAPPIE_VOICE_* overrides shorten both timers (see useVoice).
  test("idle auto-leave: hidden tab prompts, then drops the voice seat", async ({ browser }) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const w = window as unknown as { __YAPPIE_VOICE_IDLE_MS?: number; __YAPPIE_VOICE_GRACE_MS?: number };
      w.__YAPPIE_VOICE_IDLE_MS = 800;
      w.__YAPPIE_VOICE_GRACE_MS = 1500;
    });
    const page = await ctx.newPage();

    const setVisibility = (state: "hidden" | "visible") =>
      page.evaluate((s) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);

    try {
      await page.goto("/");
      await enterName(page, "IdleIvan");
      await page.getByRole("button", { name: "Create a room" }).click();
      await expect(page.locator(".room-chip strong")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: /Join voice/ }).click();
      const joined = page.getByRole("button", { name: /Leave voice/ });
      await expect(joined).toBeVisible({ timeout: 15_000 });

      // (1) Brief tab-away cancels silently — no prompt, still connected.
      await setVisibility("hidden");
      await page.waitForTimeout(300);
      await setVisibility("visible");
      await page.waitForTimeout(1000); // past idle — would have fired
      await expect(page.locator(".toast")).toHaveCount(0);
      await expect(joined).toBeVisible();

      // (2) Away for real → prompt appears; "Stay connected" holds past grace.
      await setVisibility("hidden");
      const prompt = page.locator(".toast-actions");
      await expect(prompt).toBeVisible({ timeout: 3_000 });
      await expect(prompt).toContainText("leaving voice");
      await prompt.getByRole("button", { name: "Stay connected" }).click();
      await page.waitForTimeout(1800); // past grace — stay must hold
      await expect(joined).toBeVisible();
      await setVisibility("visible");

      // (3) Away with no response → auto-leave; the Join button is the
      //     one-tap rejoin.
      await setVisibility("hidden");
      await expect(page.locator(".toast-actions")).toBeVisible({ timeout: 3_000 });
      await expect(page.getByRole("button", { name: /Join voice/ })).toBeVisible({ timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });
});
