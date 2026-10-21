/**
 * Two-client E2E: two isolated browser contexts (separate storage → separate
 * identities, like two friends on two laptops) load the extension, join one
 * room over a live relay, and we check that play / seek / pause propagate and
 * that drift stays under the re-sync threshold.
 *
 * Run:  node e2e/sync.test.mjs
 * Needs: Playwright's chromium (npx playwright install chromium).
 */
import { chromium } from "playwright";
import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const CLIP = path.join(FIXTURES, "clip.webm");

// Uses the content script's default relay port so the test exercises the
// out-of-the-box config, including the `#wp=CODE` auto-join path.
const RELAY_PORT = 8787;
const PAGE_PORT = 8792;
const EXT_PATH = path.resolve(ROOT);
const DRIFT_LIMIT_S = 0.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(label, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

/** The clip is generated once via MediaRecorder, so no binary ships in the repo. */
const WATCH_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WatchParty test page</title>
    <style>
      body { margin: 0; background: #0b0b0f; color: #fff; font-family: sans-serif; }
      video { display: block; width: 640px; height: 360px; background: #000; }
      #meta { padding: 8px; font-size: 12px; opacity: 0.7; }
    </style>
  </head>
  <body>
    <video id="v" controls playsinline muted src="clip.webm"></video>
    <div id="meta"></div>
    <script>
      const v = document.getElementById("v");
      const meta = document.getElementById("meta");
      // MediaRecorder-produced WebMs often report Infinity until forced.
      v.addEventListener("loadedmetadata", () => {
        if (!isFinite(v.duration)) {
          v.currentTime = 1e6;
          v.addEventListener("timeupdate", function fix() {
            v.removeEventListener("timeupdate", fix);
            v.currentTime = 0;
          });
        }
      });
      const paint = () => {
        meta.textContent = "duration=" + v.duration.toFixed(2) + " t=" + v.currentTime.toFixed(2);
        requestAnimationFrame(paint);
      };
      paint();
    </script>
  </body>
</html>
`;

async function ensureClip() {
  mkdirSync(FIXTURES, { recursive: true });
  await writeFile(path.join(FIXTURES, "watch.html"), WATCH_HTML);
  if (existsSync(CLIP)) return;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    const t0 = performance.now();
    await new Promise((resolve) => {
      const frame = () => {
        const t = (performance.now() - t0) / 1000;
        ctx.fillStyle = "#141828";
        ctx.fillRect(0, 0, 320, 240);
        if (t < 5) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    rec.stop();
    await done;
    const buf = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  });
  await writeFile(CLIP, Buffer.from(b64, "base64"));
  await browser.close();
  console.log("  ·   generated fixtures/clip.webm");
}

function startRelay() {
  // Spawn the real relay as a child process so the test covers the actual
  // room / host-election / validation path, not a stub.
  const child = spawn(process.execPath, [path.join(ROOT, "relay", "server.js")], {
    env: { ...process.env, PORT: String(RELAY_PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay did not start")), 8000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(t);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`relay exited early (${code})`));
    });
  });
}

function startPageServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0].split("#")[0];
    const file = url === "/" ? "/watch.html" : url;
    const full = path.join(FIXTURES, file.replace(/^\//, ""));
    if (!full.startsWith(FIXTURES) || !existsSync(full)) {
      res.writeHead(404).end("not found");
      return;
    }
    const type = full.endsWith(".html")
      ? "text/html"
      : full.endsWith(".webm")
        ? "video/webm"
        : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes" });
    createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => server.listen(PAGE_PORT, () => resolve(server)));
}

/** Seed client: mints a room, hands back the code, then leaves so a browser tab becomes host. */
async function createRoom() {
  const { default: pkg } = await import("../relay/node_modules/ws/index.js");
  const { WebSocket } = pkg;
  const ws = new WebSocket(`ws://localhost:${RELAY_PORT}`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "join", create: true, id: "seed", name: "Seed" }));
  const code = await new Promise((resolve) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "joined") resolve(m.room);
    });
  });
  // Keep the socket open until both tabs are in; leaving early deletes the room.
  return { code, close: () => ws.close() };
}

async function launchCtx(profile) {
  const dir = path.join(FIXTURES, `profile-${profile}`);
  mkdirSync(dir, { recursive: true });
  return chromium.launchPersistentContext(dir, {
    // The new headless mode (via channel) supports extensions; the old one doesn't.
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
}

/** The content script owns an open shadow root, so the pill is readable from the page. */
function pillText(page) {
  return page.evaluate(() => {
    const host = document.getElementById("wp-sync-host");
    const root = host?.shadowRoot;
    return root?.getElementById("pillText")?.textContent || "";
  });
}

function driftText(page) {
  return page.evaluate(() => {
    const root = document.getElementById("wp-sync-host")?.shadowRoot;
    const el = root?.getElementById("drift");
    return el && !el.hidden ? el.textContent : null;
  });
}

async function waitForJoined(page, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const text = await pillText(page).catch(() => "");
    if (text && text !== "WatchParty" && text.length >= 4) return text;
    await sleep(200);
  }
  throw new Error("timed out waiting to join room");
}

const videoState = (page) =>
  page.evaluate(() => {
    const v = document.getElementById("v");
    return { t: v.currentTime, paused: v.paused, duration: v.duration, ready: v.readyState };
  });

async function main() {
  console.log("WatchParty Sync — two-client E2E\n");
  await ensureClip();
  const relay = await startRelay();
  const server = await startPageServer();
  const { code, close } = await createRoom();
  console.log(`  ·   room ${code} on relay :${RELAY_PORT}, page on :${PAGE_PORT}\n`);

  const ctxA = await launchCtx("a");
  const ctxB = await launchCtx("b");
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const url = `http://localhost:${PAGE_PORT}/watch.html#wp=${code}`;

  await a.goto(url);
  await b.goto(url);

  console.log("join");
  const roomA = await waitForJoined(a);
  const roomB = await waitForJoined(b);
  check("both tabs joined the same room", roomA === code && roomB === code, `${roomA}/${roomB}`);
  close(); // seed leaves → first browser tab becomes host

  await sleep(600);
  const pillA = await pillText(a);
  check("page has no console-fatal error", pillA === code, pillA);

  // Media needs metadata before the extension can identify the title.
  await a.waitForFunction(() => isFinite(document.getElementById("v").duration), null, { timeout: 10000 });
  await b.waitForFunction(() => isFinite(document.getElementById("v").duration), null, { timeout: 10000 });

  console.log("\nplay");
  await a.evaluate(() => {
    const v = document.getElementById("v");
    v.currentTime = 0;
    return v.play();
  });
  await sleep(1600);
  const pa = await videoState(a);
  const pb = await videoState(b);
  check("B is playing", pb.paused === false, `paused=${pb.paused}`);
  check("B follows A's position", Math.abs(pa.t - pb.t) < DRIFT_LIMIT_S, `A=${pa.t.toFixed(2)} B=${pb.t.toFixed(2)}`);

  console.log("\nseek (while paused — isolates seek from playback advance)");
  await a.evaluate(() => document.getElementById("v").pause());
  await sleep(800);
  await a.evaluate(() => {
    document.getElementById("v").currentTime = 3.5;
  });
  await sleep(1400);
  const sa = await videoState(a);
  const sb = await videoState(b);
  check("B seeked with A", Math.abs(sb.t - 3.5) < DRIFT_LIMIT_S, `B=${sb.t.toFixed(2)}`);
  check("A/B aligned after seek", Math.abs(sa.t - sb.t) < DRIFT_LIMIT_S, `A=${sa.t.toFixed(2)} B=${sb.t.toFixed(2)}`);

  console.log("\nresume after seek");
  await a.evaluate(() => document.getElementById("v").play());
  await sleep(1400);
  const ra = await videoState(a);
  const rb = await videoState(b);
  check("B resumed with A", rb.paused === false, `paused=${rb.paused}`);
  check("A/B aligned while playing", Math.abs(ra.t - rb.t) < DRIFT_LIMIT_S, `A=${ra.t.toFixed(2)} B=${rb.t.toFixed(2)}`);

  // Drift pill only shows while playing — there's no timeline to measure
  // against once paused, and it correctly hides itself.
  const drift = await driftText(b);
  check("drift pill visible and under threshold while playing", drift !== null, `pill=${drift}`);
  const driftNum = drift ? parseFloat(drift) : NaN;
  check("drift value under threshold", Number.isFinite(driftNum) && driftNum < DRIFT_LIMIT_S, `drift=${drift}`);

  console.log("\npause");
  await a.evaluate(() => document.getElementById("v").pause());
  await sleep(1200);
  const qa = await videoState(a);
  const qb = await videoState(b);
  check("B paused with A", qb.paused === true, `paused=${qb.paused}`);
  check("B holds A's position while paused", Math.abs(qa.t - qb.t) < DRIFT_LIMIT_S, `A=${qa.t.toFixed(2)} B=${qb.t.toFixed(2)}`);

  // Drift is meaningless while paused, so the pill hides itself.
  const driftPaused = await driftText(b);
  check("drift pill hides when paused", driftPaused === null, `pill=${driftPaused}`);

  await ctxA.close();
  await ctxB.close();
  server.close();
  relay.kill();

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nE2E harness error:", err);
  process.exit(1);
});
