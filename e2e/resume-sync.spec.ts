import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Resume + drift regression: a paused room's position must survive a join —
 * both when the host is online (live snapshot answer) and when the host is
 * gone (rooms.playback fallback, migration 0015). Guards the incident where
 * a joiner sat at 0:00 while both clients showed "in sync".
 *
 * YouTube in fresh headless contexts sometimes stalls behind a consent/bot
 * wall — seed Google consent cookies and skip (not fail) when the player
 * never gets metadata, so an environment block never masks an app failure.
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

async function seedConsent(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" },
    { name: "CONSENT", value: "YES+cb", domain: ".youtube.com", path: "/" },
  ]);
}

function captureConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (msg) => {
    if (lines.length < 60) lines.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    if (lines.length < 60) lines.push(`pageerror: ${err.message}`);
  });
  return lines;
}

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

/** Current position from the controls time label, in seconds. */
async function readTime(page: Page): Promise<number> {
  const label = await page.locator(".time-label").innerText();
  const cur = label.split("/")[0].trim();
  const [m, s] = cur.split(":").map((n) => Number(n));
  return m * 60 + (s || 0);
}

async function diag(page: Page, label: string, logs: string[]): Promise<string> {
  const time = await page.locator(".time-label").innerText().catch(() => "?");
  const chips = await page.locator(".watcher-chip").count().catch(() => -1);
  const iframe = await page.locator("iframe").count().catch(() => -1);
  return `[${label}] time-label="${time}" watcher-chips=${chips} iframes=${iframe} console=${JSON.stringify(logs.slice(-12))}`;
}

/** Wire trace: realtime frames (WS both ways) + REST broadcasts + rooms-row writes. */
function captureWire(page: Page, tag: string, sink: string[]): void {
  const interesting = (s: string) =>
    !s.includes("heartbeat") &&
    !s.includes("presence_diff") &&
    (s.includes("control") || s.includes("snapshot") || s.includes("sync-request"));
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => {
      const s = String(f.payload);
      if (interesting(s)) sink.push(`[${tag}>>ws] ${s.slice(0, 420)}`);
    });
    ws.on("framereceived", (f) => {
      const s = String(f.payload);
      if (interesting(s)) sink.push(`[${tag}<<ws] ${s.slice(0, 420)}`);
    });
  });
  page.on("request", (req) => {
    const u = req.url();
    if (req.method() === "POST" && u.includes("/realtime/"))
      sink.push(`[${tag}>>post] ${req.postData()?.slice(0, 420)}`);
    if (req.method() === "PATCH" && u.includes("/rest/v1/rooms"))
      sink.push(`[${tag}>>db] PATCH ${req.postData()?.slice(0, 400)}`);
  });
  page.on("response", (res) => {
    const rq = res.request();
    const u = res.url();
    if (rq.method() === "POST" && u.includes("/realtime/"))
      sink.push(`[${tag}<<post] ${res.status()}`);
    if (rq.method() === "PATCH" && u.includes("/rest/v1/rooms"))
      sink.push(`[${tag}<<db] ${res.status()}`);
  });
}

/** Read rooms.playback straight from the REST API (anon RLS — same read the app does). */
async function readRoomRow(code: string): Promise<string> {
  const base = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!base || !key) return "no-env";
  const res = await fetch(
    `${base}/rest/v1/rooms?code=eq.${code}&select=video_id,playback,host_id`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  const body = await res.text();
  return `HTTP ${res.status} ${body.slice(0, 300)}`;
}

/**
 * Load a video as host and park it at ~120s, paused.
 * Skips the test when YouTube metadata never arrives (environment block).
 */
async function loadAndPark(page: Page, logs: string[]): Promise<void> {
  await page.fill("#load-input", "https://youtu.be/dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Load", exact: true }).click();
  try {
    await expect(page.locator(".time-label")).toContainText("3:33", { timeout: 45_000 });
  } catch {
    test.skip(true, `YouTube player never loaded — environment block. ${await diag(page, "host", logs)}`);
  }
  // Seek to ~120s with the focused-slider keyboard handler (4 × Shift+→).
  await page.locator(".seek").focus();
  for (let i = 0; i < 4; i++) await page.press(".seek", "Shift+ArrowRight");
  await expect
    .poll(() => readTime(page), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(105);
  // Toggle until genuinely paused: with autoplay blocked the store intent can
  // say "playing" while the adapter is paused (or vice versa), so one click
  // may toggle the wrong way. Click → settle → re-read title, up to 4 rounds.
  for (let i = 0; i < 4; i++) {
    const title = await page.locator(".ctrl-btn.play").getAttribute("title");
    if (title?.includes("Play (Space)")) break;
    await page.locator(".ctrl-btn.play").click();
    await page.waitForTimeout(700);
  }
  // A blocked-autoplay player settles to paused within ~2 ticks (5s cadence).
  try {
    await expect(page.locator(".ctrl-btn.play")).toHaveAttribute("title", /Play \(Space\)/, {
      timeout: 20_000,
    });
  } catch {
    test.skip(true, `player never settled to paused — environment/autoplay block. ${await diag(page, "host", logs)}`);
  }
  await page.waitForTimeout(1500);
}

test.describe("resume-sync", () => {
  test.skip(!configured, "needs .env.local Supabase keys + migrations applied");

  test("guest joins a paused room at the same position (host online)", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    await seedConsent(hostCtx);
    await seedConsent(guestCtx);
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();
    const hostLogs = captureConsole(host);
    const guestLogs = captureConsole(guest);
    const wire: string[] = [];
    captureWire(host, "host", wire);
    captureWire(guest, "guest", wire);
    try {
      await host.goto("/");
      await enterName(host, "ParkHost");
      const code = await createRoom(host);
      await loadAndPark(host, hostLogs);
      const hostTime = await readTime(host);
      expect(hostTime).toBeGreaterThanOrEqual(105);
      console.log(`[row@park] ${await readRoomRow(code)}`);
      // Sample the host solo (no guest yet): does it move or resume by itself?
      await host.waitForTimeout(3000);
      const hostSolo = await readTime(host);
      console.log(`[host@t+3s solo] ${hostSolo} (parked ${hostTime})`);
      console.log(`[row@t+3s] ${await readRoomRow(code)}`);

      await guest.goto("/");
      await enterName(guest, "LateGuest");
      await joinRoom(guest, code);

      for (let i = 0; i < 4; i++) {
        await host.waitForTimeout(2500);
        console.log(
          `[host@t+${(i + 1) * 2.5}s] time=${await readTime(host)} | guest=${await readTime(guest).catch(() => "?")}`,
        );
      }
      try {
        await expect
          .poll(() => readTime(guest), { timeout: 30_000 })
          .toBeGreaterThanOrEqual(hostTime - 15);
      } catch (e) {
        console.log(await diag(guest, "guest", guestLogs));
        console.log(await diag(host, "host", hostLogs));
        console.log(`[row@end] ${await readRoomRow(code)}`);
        throw e;
      }
      const guestTime = await readTime(guest);
      expect(Math.abs(guestTime - hostTime)).toBeLessThanOrEqual(15);
      await expect(guest.locator(".sync-chip")).toContainText("in sync", { timeout: 15_000 });
    } finally {
      console.log(`WIRE:\n${wire.join("\n")}`);
      await hostCtx.close();
      await guestCtx.close();
    }
  });

  test("guest joins at the same position after the host tab is gone (playback row fallback)", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    await seedConsent(hostCtx);
    const host = await hostCtx.newPage();
    const hostLogs = captureConsole(host);
    const wire: string[] = [];
    captureWire(host, "host", wire);
    let code = "";
    try {
      await host.goto("/");
      await enterName(host, "GoneHost");
      code = await createRoom(host);
      await loadAndPark(host, hostLogs);
      const hostTime = await readTime(host);
      expect(hostTime).toBeGreaterThanOrEqual(105);
      console.log(`[row@park] ${await readRoomRow(code)}`);
      // Close the host tab: pagehide flushes the position to rooms.playback.
      await hostCtx.close();
      console.log(`[row@after-close] ${await readRoomRow(code)}`);
    } catch (e) {
      await hostCtx.close();
      throw e;
    }

    const guestCtx = await browser.newContext();
    await seedConsent(guestCtx);
    const guest = await guestCtx.newPage();
    const guestLogs = captureConsole(guest);
    captureWire(guest, "guest", wire);
    try {
      await guest.goto("/");
      await enterName(guest, "RowGuest");
      await joinRoom(guest, code);

      // No host to answer the sync request — resume must come from the row.
      try {
        await expect
          .poll(() => readTime(guest), { timeout: 30_000 })
          .toBeGreaterThanOrEqual(100);
      } catch (e) {
        console.log(await diag(guest, "guest", guestLogs));
        console.log(`[row@fail] ${await readRoomRow(code)}`);
        throw e;
      }
      try {
        await expect(guest.locator(".sync-chip")).toContainText("in sync", { timeout: 15_000 });
      } catch (e) {
        console.log(
          `[chip@fail] guestTime=${await readTime(guest)} chip=${await guest.evaluate(() => document.querySelector(".sync-chip")?.textContent)}`,
        );
        console.log(await diag(guest, "guest@chip", guestLogs));
        console.log(`[row@chipfail] ${await readRoomRow(code)}`);
        throw e;
      }
    } finally {
      console.log(`WIRE:\n${wire.join("\n")}`);
      await guestCtx.close();
    }
  });
});
