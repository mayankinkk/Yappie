/**
 * WatchParty Sync — content script.
 *
 * Hooks the page's HTML5 <video> element and mirrors play/pause/seek to the
 * rest of the room. Carries no video data: only control events cross the wire.
 *
 * Position is anchored to *receipt* time rather than the sender's wall clock,
 * so peers with skewed clocks still line up. The cost is that we inherit one
 * transit delay (~50-200ms on the open internet) instead of clock error, which
 * is well under the 0.75s re-sync threshold.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- config

  const OUT_GAP_MS = 150; // coalesce control bursts (payloads are full snapshots)
  const SYNC_REQ_GAP_MS = 3000;
  const DRIFT_THRESHOLD_S = 0.75; // beyond this, re-seek
  const DRIFT_YELLOW_S = 0.5;
  const DRIFT_RED_S = 1.5;
  const SEEK_EPSILON_S = 0.35; // ignore sub-frame seeks when applying
  const APPLY_GUARD_MS = 900; // suppress echo from our own remote-apply
  const TICK_MS = 1000;
  const MAX_AGE_MS = 15_000; // drop control events older than this
  const CHAT_MAX = 500;
  const RECONNECT_MS = 1500;

  // ---------------------------------------------------------------- state

  /** @type {string} */
  let selfId = "";
  let selfName = "Guest";
  /** @type {string | null} */
  let room = null;
  let pendingCreate = false;
  let joined = false;
  let hostId = "";
  let guestsCanControl = false;
  /** @type {{ id: string, name: string, host: boolean }[]} */
  let peers = [];
  /** @type {WebSocket | null} */
  let ws = null;
  let reconnectTimer = null;
  let shouldReconnect = false;

  /** @type {HTMLVideoElement | null} */
  let video = null;
  let videoObserver = null;

  /** Latest state we last broadcast, used for drift measurement + coalescing. */
  let localRef = { videoId: "", time: 0, playing: false, sentAtLocal: 0 };
  /** @type {Record<string, number>} */
  let seqBySender = {};
  let selfSeq = 0;
  let applying = false;
  let applyTimer = null;
  let outTimer = null;
  let lastOutAt = 0;
  let lastSyncReqAt = 0;
  let lastDrift = null;

  // ---------------------------------------------------------------- identity

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function loadIdentity() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["wpId", "wpName", "relayUrl"], (r) => {
        selfId = typeof r.wpId === "string" && r.wpId ? r.wpId : uuid();
        selfName = typeof r.wpName === "string" && r.wpName ? r.wpName : "Guest";
        relayUrl = typeof r.relayUrl === "string" && r.relayUrl ? r.relayUrl : DEFAULT_RELAY;
        chrome.storage.local.set({ wpId: selfId, relayUrl });
        resolve();
      });
    });
  }

  // config.js is loaded first by the manifest and sets globalThis.WP_CONFIG.
  const CONFIGURED_RELAY = (globalThis.WP_CONFIG && globalThis.WP_CONFIG.WS_RELAY_URL) || "";
  const DEFAULT_RELAY = CONFIGURED_RELAY || "ws://localhost:8787";
  let relayUrl = DEFAULT_RELAY;

  // ---------------------------------------------------------------- video

  /**
   * Pick the most plausible <video> on the page: the largest one that is
   * actually rendered. Re-scanned on DOM changes so SPAs that swap the player
   * in late are still picked up.
   */
  function findVideo() {
    const nodes = [...document.querySelectorAll("video")];
    if (nodes.length === 0) return null;
    let best = null;
    let bestArea = 0;
    for (const v of nodes) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    // A page with a single off-screen <video> (preloads, hidden players) still
    // counts — some players only size themselves after the first frame.
    return best || nodes[0];
  }

  function startVideoWatcher() {
    const adopt = () => {
      const next = findVideo();
      if (next === video) return;
      detachVideo();
      video = next;
      if (video) attachVideo();
      render();
    };
    adopt();
    videoObserver = new MutationObserver(() => {
      if (adopt.pending) return;
      adopt.pending = true;
      setTimeout(() => {
        adopt.pending = false;
        adopt();
      }, 250);
    });
    videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener("play", onLocalPlay);
    video.removeEventListener("pause", onLocalPause);
    video.removeEventListener("seeked", onLocalSeek);
    video.removeEventListener("loadedmetadata", onMeta);
    video = null;
  }

  function attachVideo() {
    video.addEventListener("play", onLocalPlay);
    video.addEventListener("pause", onLocalPause);
    video.addEventListener("seeked", onLocalSeek);
    video.addEventListener("loadedmetadata", onMeta);
  }

  /**
   * A stable-ish identity for "the same thing is on screen for everyone".
   * Page URL + duration distinguishes titles on catalogue sites; direct media
   * URLs carry the filename in the path already. Blob/MSE sources are
   * deliberately excluded — they differ per client and would never match.
   */
  function videoKey() {
    if (!video) return null;
    const dur = Math.round(video.duration || 0);
    if (!dur) return null; // metadata not loaded yet — can't identify the title
    const href = location.href.split("#")[0];
    return `${href}#${dur}`;
  }

  const player = {
    ready: () => !!video && video.readyState >= 1 && Number.isFinite(video.duration),
    getTime: () => (video ? video.currentTime : 0),
    isPlaying: () => !!video && !video.paused && !video.ended,
    play: () => {
      if (!video) return;
      void video.play().catch(() => {});
    },
    pause: () => {
      if (video) video.pause();
    },
    seek: (t) => {
      if (!video) return;
      try {
        video.currentTime = t;
      } catch {
        /* seeking can throw on not-yet-seekable media; next tick retries */
      }
    },
  };

  // ---------------------------------------------------------------- sync

  function canControl() {
    if (!selfId) return false;
    if (selfId === hostId) return true;
    return guestsCanControl;
  }

  function guardApply() {
    applying = true;
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applying = false;
    }, APPLY_GUARD_MS);
  }

  /** Position a peer should be at right now, given what they last sent us. */
  function expectedTime(anchor, now = performance.now()) {
    const ageMs = Math.max(0, Math.min(MAX_AGE_MS, now - anchor.receivedAtLocal));
    return Math.max(0, anchor.time + (anchor.playing ? ageMs / 1000 : 0));
  }

  const lastAnchorBySender = {};

  function applyControl(raw) {
    const p = raw;
    if (!p || typeof p.videoId !== "string" || typeof p.time !== "number") return;
    if (!Number.isFinite(p.time) || p.time < 0) return;
    if (typeof p.seq !== "number") return;
    const sender = String(p.senderId || "");
    if (!sender) return;
    // Per-sender sequence drops retransmits and out-of-order frames without
    // leaning on wall clocks (which may disagree across peers).
    if (seqBySender[sender] !== undefined && p.seq <= seqBySender[sender]) return;
    seqBySender[sender] = p.seq;

    const mine = videoKey();
    if (mine && mine !== p.videoId) {
      ui.notice(`Host is on a different video (${p.senderName || "host"})`, "warn");
      return;
    }
    if (!player.ready()) {
      // Media not ready yet — remember it and retry on loadedmetadata.
      lastAnchorBySender[sender] = { ...p, receivedAtLocal: performance.now() };
      return;
    }

    const anchor = { time: p.time, playing: !!p.playing, receivedAtLocal: performance.now() };
    lastAnchorBySender[sender] = anchor;

    const target = expectedTime(anchor);
    const cur = player.getTime();
    guardApply();
    if (Math.abs(cur - target) > SEEK_EPSILON_S) player.seek(target);
    if (p.playing) player.play();
    else player.pause();

    localRef = { videoId: p.videoId, time: target, playing: !!p.playing, sentAtLocal: performance.now() };
    lastDrift = 0;
    ui.setDrift(0);
    if (p.notify && p.senderName) {
      const verb =
        p.action === "pause" ? "paused" : p.action === "seek" ? "skipped" : p.action === "load" ? "shared a video" : "pressed play";
      ui.notice(`${p.senderName} ${verb}`);
    }
    render();
  }

  /** Called on our own play/pause/seek. Only the controller broadcasts. */
  function broadcast(action, notify) {
    const vid = videoKey();
    if (!vid || !joined) return;
    if (!canControl()) {
      if (action !== "seek" || notify) ui.notice("Asked the host for control");
      requestControl();
      return;
    }
    const now = performance.now();
    const time = player.ready() ? player.getTime() : localRef.time;
    const playing = player.ready() ? player.isPlaying() : localRef.playing;

    // Full-snapshot payloads: safe to coalesce a burst into one trailing send.
    if (action !== "load" && now - lastOutAt < OUT_GAP_MS) {
      if (!outTimer) {
        outTimer = setTimeout(() => {
          outTimer = null;
          flushCoalesced();
        }, OUT_GAP_MS / 2);
      }
      localRef = { videoId: vid, time, playing, sentAtLocal: now };
      return;
    }
    lastOutAt = now;
    localRef = { videoId: vid, time, playing, sentAtLocal: now };
    sendControl({ videoId: vid, time, playing, action, notify });
    ui.setDrift(0);
    render();
  }

  function flushCoalesced() {
    if (!joined || applying) return;
    const vid = videoKey();
    if (!vid || !canControl()) return;
    const now = performance.now();
    if (now - lastOutAt < OUT_GAP_MS) {
      outTimer = setTimeout(() => {
        outTimer = null;
        flushCoalesced();
      }, OUT_GAP_MS / 2);
      return;
    }
    lastOutAt = now;
    const time = player.ready() ? player.getTime() : localRef.time;
    const playing = player.ready() ? player.isPlaying() : localRef.playing;
    localRef = { videoId: vid, time, playing, sentAtLocal: now };
    sendControl({ videoId: vid, time, playing, action: playing ? "play" : "pause", notify: false });
  }

  function sendControl(fields) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    selfSeq += 1;
    ws.send(JSON.stringify({ type: "control", payload: { ...fields, seq: selfSeq } }));
  }

  function requestControl() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "control-request" }));
  }

  /** Every second: measure drift vs. our anchor and re-seek if we've slid. */
  function tick() {
    if (!joined || applying || !player.ready()) return;
    const anchor = lastAnchorBySender[hostId];
    if (!anchor || !anchor.playing) {
      lastDrift = null;
      render();
      return;
    }
    const expected = expectedTime(anchor);
    const actual = player.getTime();
    const drift = Math.abs(actual - expected);
    lastDrift = drift;
    ui.setDrift(drift);
    if (!player.isPlaying()) return;
    if (drift > DRIFT_THRESHOLD_S && drift < 120) {
      guardApply();
      player.seek(expected);
      localRef = { ...localRef, time: expected, sentAtLocal: performance.now() };
    }
    render();
  }

  // ---------------------------------------------------------------- events

  function onLocalPlay() {
    if (applying) return;
    broadcast("play", true);
  }
  function onLocalPause() {
    if (applying) return;
    broadcast("pause", true);
  }
  function onLocalSeek() {
    if (applying) return;
    broadcast("seek", true);
  }
  function onMeta() {
    // Media just became identifiable/seekable — catch up to the host if we're behind.
    if (!joined || !hostId) return;
    const anchor = lastAnchorBySender[hostId];
    if (!anchor || !player.ready()) return;
    const target = expectedTime(anchor);
    if (Math.abs(player.getTime() - target) > SEEK_EPSILON_S) {
      guardApply();
      player.seek(target);
      if (anchor.playing) player.play();
    }
    render();
  }

  // ---------------------------------------------------------------- socket

  function connect() {
    if (!room && !pendingCreate) return;
    shouldReconnect = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ui.setStatus("connecting");
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      ui.setStatus("offline");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      ws.send(
        JSON.stringify(
          pendingCreate
            ? { type: "join", create: true, id: selfId, name: selfName }
            : { type: "join", room, id: selfId, name: selfName },
        ),
      );
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "joined": {
          joined = true;
          pendingCreate = false;
          room = msg.room;
          hostId = msg.hostId || "";
          peers = msg.peers || [];
          guestsCanControl = false;
          ui.setStatus("joined");
          ui.notice(`Joined room ${room}`);
          requestSync();
          render();
          reportState();
          break;
        }
        case "peers": {
          peers = msg.peers || [];
          const me = peers.find((p) => p.id === selfId);
          if (me) selfName = me.name;
          const newHost = peers.find((p) => p.host);
          if (newHost) hostId = newHost.id;
          render();
          reportState();
          break;
        }
        case "host-changed": {
          hostId = msg.hostId || hostId;
          ui.notice(selfId === hostId ? "You are now the host" : "Host changed", "info");
          render();
          reportState();
          break;
        }
        case "control": {
          applyControl(msg.payload);
          reportState();
          break;
        }
        case "sync-request": {
          // A late joiner wants our position — reply with a fresh snapshot.
          if (selfId !== hostId) break;
          if (performance.now() - lastSyncReqAt < 2000) break;
          lastSyncReqAt = performance.now();
          setTimeout(() => {
            const vid = videoKey();
            if (!vid || !player.ready()) return;
            sendControl({
              videoId: vid,
              time: player.getTime(),
              playing: player.isPlaying(),
              action: player.isPlaying() ? "play" : "pause",
              notify: false,
            });
          }, 80 + Math.random() * 220);
          break;
        }
        case "room-settings": {
          if (msg.senderId !== hostId) break;
          guestsCanControl = !!msg.guestsCanControl;
          ui.notice(guestsCanControl ? "The host unlocked playback control" : "The host locked playback control");
          render();
          break;
        }
        case "control-request": {
          if (selfId !== hostId) break;
          ui.notice(`${msg.senderName || "Someone"} asked for control — click Unlock to allow`, "warn");
          break;
        }
        case "chat": {
          ui.addChat(msg);
          break;
        }
        case "error": {
          joined = false;
          ui.setStatus("error");
          ui.notice(
            msg.error === "room_not_found" ? "Room not found" : msg.error === "room_full" ? "Room is full" : "Server error",
            "error",
          );
          shouldReconnect = false;
          render();
          reportState();
          break;
        }
        case "left": {
          joined = false;
          room = null;
          ui.setStatus("idle");
          render();
          reportState();
          break;
        }
        default:
          break;
      }
    };

    ws.onclose = () => {
      ws = null;
      if (joined) ui.notice("Disconnected", "warn");
      joined = false;
      ui.setStatus("offline");
      render();
      reportState();
      if (shouldReconnect) scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose follows and handles teardown */
    };
  }

  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (shouldReconnect) connect();
    }, RECONNECT_MS);
  }

  function requestSync() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - lastSyncReqAt < SYNC_REQ_GAP_MS) return;
    lastSyncReqAt = now;
    ws.send(JSON.stringify({ type: "sync-request" }));
  }

  function sendChat(text) {
    const t = String(text || "").trim().slice(0, CHAT_MAX);
    if (!t || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "chat", text: t }));
  }

  function sendToggleControl() {
    if (selfId !== hostId) return;
    guestsCanControl = !guestsCanControl;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "room-settings", guestsCanControl }));
    }
    // Re-broadcast a snapshot so everyone re-anchors on the same second.
    const vid = videoKey();
    if (vid && player.ready()) {
      sendControl({
        videoId: vid,
        time: player.getTime(),
        playing: player.isPlaying(),
        action: player.isPlaying() ? "play" : "pause",
        notify: false,
      });
    }
    ui.notice(guestsCanControl ? "Control unlocked for everyone" : "Control locked to host");
    render();
  }

  function leave() {
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "leave", hostId }));
    if (ws) {
      ws.close();
      ws = null;
    }
    joined = false;
    room = null;
    pendingCreate = false;
    hostId = "";
    peers = [];
    seqBySender = {};
    lastAnchorBySender = {};
    ui.setStatus("idle");
    render();
    reportState();
  }

  function reportState() {
    try {
      chrome.runtime.sendMessage({
        type: "wp-state",
        joined,
        room,
        peerCount: peers.length,
        controlling: canControl(),
        status: ui.status,
      });
    } catch {
      /* popup/background may be asleep — not fatal */
    }
  }

  // ---------------------------------------------------------------- ui

  const ui = (() => {
    const host = document.createElement("div");
    host.id = "wp-sync-host";
    host.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .wrap { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
        .pill {
          display:flex; align-items:center; gap:8px;
          background: rgba(17,17,20,.92); color:#fff; border:1px solid rgba(255,255,255,.12);
          border-radius:999px; padding:6px 10px 6px 12px; cursor:pointer;
          font-size:12px; line-height:1; backdrop-filter: blur(8px);
          box-shadow:0 4px 16px rgba(0,0,0,.35); user-select:none;
        }
        .dot { width:8px; height:8px; border-radius:50%; background:#666; flex:none; }
        .dot.joined { background:#34d399; }
        .dot.connecting { background:#fbbf24; }
        .dot.error, .dot.offline { background:#f87171; }
        .drift { font-variant-numeric: tabular-nums; font-size:11px; opacity:.9; }
        .drift.ok { color:#34d399; } .drift.warn { color:#fbbf24; } .drift.bad { color:#f87171; }
        .chev { opacity:.5; font-size:10px; }
        .panel {
          width:300px; max-height:70vh; display:flex; flex-direction:column;
          background: rgba(17,17,20,.96); color:#fff; border:1px solid rgba(255,255,255,.12);
          border-radius:12px; overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,.5);
        }
        .panel[hidden] { display:none; }
        .head { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08); display:flex; align-items:center; gap:8px; }
        .code { font-weight:600; letter-spacing:.5px; font-size:13px; }
        .copy { background:rgba(255,255,255,.08); border:0; color:#fff; border-radius:6px; padding:3px 8px; font-size:11px; cursor:pointer; }
        .copy:hover { background:rgba(255,255,255,.16); }
        .members { padding:8px 12px; border-bottom:1px solid rgba(255,255,255,.08); }
        .members h4, .chat h4 { margin:0 0 6px; font-size:10px; text-transform:uppercase; letter-spacing:.8px; opacity:.5; font-weight:600; }
        .member { display:flex; align-items:center; gap:6px; font-size:12px; padding:2px 0; }
        .badge { background:#6366f1; color:#fff; font-size:9px; padding:1px 5px; border-radius:4px; font-weight:600; }
        .role { padding:8px 12px; display:flex; align-items:center; justify-content:space-between; gap:8px; border-bottom:1px solid rgba(255,255,255,.08); font-size:12px; }
        .toggle { background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.14); color:#fff; border-radius:6px; padding:4px 8px; font-size:11px; cursor:pointer; }
        .toggle[disabled] { opacity:.35; cursor:not-allowed; }
        .toggle.on { background:#6366f1; border-color:#6366f1; }
        .chat { flex:1; display:flex; flex-direction:column; min-height:120px; }
        .msgs { flex:1; overflow-y:auto; padding:8px 12px; font-size:12px; display:flex; flex-direction:column; gap:4px; }
        .msg .who { font-weight:600; opacity:.75; margin-right:4px; }
        .msg.system { opacity:.5; font-style:italic; }
        .composer { display:flex; gap:6px; padding:8px 12px; border-top:1px solid rgba(255,255,255,.08); }
        .composer input { flex:1; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); border-radius:6px; color:#fff; padding:6px 8px; font-size:12px; }
        .composer input:focus { outline:none; border-color:#6366f1; }
        .composer button { background:#6366f1; border:0; color:#fff; border-radius:6px; padding:0 10px; cursor:pointer; font-size:12px; }
        .foot { padding:8px 12px; border-top:1px solid rgba(255,255,255,.08); display:flex; gap:6px; }
        .foot button { flex:1; background:rgba(255,255,255,.08); border:0; color:#fff; border-radius:6px; padding:6px; font-size:11px; cursor:pointer; }
        .foot button.leave { background:rgba(248,113,113,.18); color:#fca5a5; }
        .notice {
          max-width:260px; background:rgba(17,17,20,.95); color:#fff; border:1px solid rgba(255,255,255,.12);
          border-radius:8px; padding:7px 10px; font-size:12px; box-shadow:0 4px 16px rgba(0,0,0,.35);
          opacity:0; transform:translateY(-4px); transition:opacity .18s, transform .18s; pointer-events:none;
        }
        .notice.show { opacity:1; transform:none; }
        .notice.warn { border-color:rgba(251,191,36,.5); }
        .notice.error { border-color:rgba(248,113,113,.5); }
        .empty { opacity:.45; font-size:12px; padding:2px 0; }
      </style>
      <div class="wrap">
        <div class="notice" id="notice"></div>
        <div class="panel" id="panel" hidden>
          <div class="head">
            <span class="code" id="code">—</span>
            <button class="copy" id="copy">Copy invite</button>
          </div>
          <div class="members">
            <h4>Watching (<span id="count">0</span>)</h4>
            <div id="memberList"></div>
          </div>
          <div class="role">
            <span id="roleText">Locked to host</span>
            <button class="toggle" id="ctrlToggle">Unlock</button>
          </div>
          <div class="chat">
            <h4>Chat</h4>
            <div class="msgs" id="msgs"><div class="empty">No messages yet</div></div>
            <form class="composer" id="composer">
              <input id="chatInput" placeholder="Say something…" maxlength="${CHAT_MAX}" autocomplete="off" />
              <button type="submit">Send</button>
            </form>
          </div>
          <div class="foot">
            <button id="requestSync">Resync</button>
            <button class="leave" id="leaveBtn">Leave</button>
          </div>
        </div>
        <div class="pill" id="pill" title="WatchParty Sync">
          <span class="dot" id="dot"></span>
          <span id="pillText">WatchParty</span>
          <span class="drift" id="drift" hidden></span>
          <span class="chev">▾</span>
        </div>
      </div>
    `;

    const $ = (id) => shadow.getElementById(id);
    const panel = $("panel");
    const pill = $("pill");
    const noticeEl = $("notice");
    let noticeTimer = null;
    let chatLines = [];

    pill.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
    });

    $("copy").addEventListener("click", async () => {
      if (!room) return;
      const url = `${location.href.split("#")[0]}#wp=${room}`;
      try {
        await navigator.clipboard.writeText(url);
        api.notice("Invite link copied");
      } catch {
        api.notice(`Room code: ${room}`, "info");
      }
    });

    $("composer").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("chatInput");
      const v = input.value;
      input.value = "";
      api.onChat(v);
    });

    $("leaveBtn").addEventListener("click", () => api.onLeave());
    $("requestSync").addEventListener("click", () => api.onResync());
    $("ctrlToggle").addEventListener("click", () => api.onToggleControl());

    const api = {
      status: "idle",
      setStatus(s) {
        api.status = s;
        const dot = $("dot");
        dot.className = `dot ${s}`;
        $("pillText").textContent = s === "joined" && room ? room : "WatchParty";
      },
      setDrift(seconds) {
        const el = $("drift");
        if (!joined || seconds === null || seconds === undefined) {
          el.hidden = true;
          return;
        }
        el.hidden = false;
        const cls = seconds < DRIFT_YELLOW_S ? "ok" : seconds < DRIFT_RED_S ? "warn" : "bad";
        el.className = `drift ${cls}`;
        el.textContent = `${seconds.toFixed(2)}s`;
      },
      notice(text, kind = "info") {
        noticeEl.textContent = text;
        noticeEl.className = `notice show ${kind}`;
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
          noticeEl.className = "notice";
        }, 2600);
      },
      addChat(msg) {
        chatLines.push(msg);
        if (chatLines.length > 100) chatLines = chatLines.slice(-100);
        const box = $("msgs");
        box.innerHTML = "";
        for (const m of chatLines) {
          const div = document.createElement("div");
          div.className = `msg${m.system ? " system" : ""}`;
          if (m.system) div.textContent = m.text;
          else {
            const who = document.createElement("span");
            who.className = "who";
            who.textContent = m.senderName || "Someone";
            div.appendChild(who);
            div.appendChild(document.createTextNode(m.text));
          }
          box.appendChild(div);
        }
        box.scrollTop = box.scrollHeight;
      },
      render(state) {
        $("code").textContent = state.room || "—";
        $("count").textContent = String(state.peers.length);
        const list = $("memberList");
        list.innerHTML = "";
        if (state.peers.length === 0) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = "Nobody here yet";
          list.appendChild(e);
        }
        for (const p of state.peers) {
          const row = document.createElement("div");
          row.className = "member";
          const nm = document.createElement("span");
          nm.textContent = p.name + (p.id === selfId ? " (you)" : "");
          row.appendChild(nm);
          if (p.host) {
            const b = document.createElement("span");
            b.className = "badge";
            b.textContent = "HOST";
            row.appendChild(b);
          }
          list.appendChild(row);
        }
        const isHost = selfId === hostId;
        const btn = $("ctrlToggle");
        btn.disabled = !isHost;
        btn.className = `toggle${state.guestsCanControl ? " on" : ""}`;
        btn.textContent = state.guestsCanControl ? "Locked" : "Unlock";
        $("roleText").textContent = state.guestsCanControl ? "Everyone can control" : isHost ? "You control playback" : "Waiting for host to unlock";
      },
    };
    // Attach to the page — without this the shadow root exists but is never
    // rendered, so the pill and panel stay invisible.
    (document.documentElement || document.body).appendChild(host);
    return api;
  })();

  // ---------------------------------------------------------------- render

  function render() {
    ui.render({ room, peers, guestsCanControl });
    ui.setDrift(lastDrift);
  }

  // ---------------------------------------------------------------- bridge

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "wp-join": {
        if (msg.name) {
          selfName = String(msg.name).slice(0, 24) || "Guest";
          chrome.storage.local.set({ wpName: selfName });
        }
        if (msg.relayUrl) {
          relayUrl = String(msg.relayUrl);
          chrome.storage.local.set({ relayUrl });
        }
        if (joined && room && room !== msg.room) leave();
        if (msg.create) {
          room = null;
          pendingCreate = true;
          connect();
          sendResponse({ ok: true, create: true });
          return true;
        }
        room = String(msg.room || "").toUpperCase().trim();
        if (!room) {
          sendResponse({ ok: false, error: "no_room" });
          return true;
        }
        pendingCreate = false;
        connect();
        sendResponse({ ok: true, room });
        return true;
      }
      case "wp-leave":
        leave();
        sendResponse({ ok: true });
        return true;
      case "wp-chat":
        sendChat(msg.text);
        sendResponse({ ok: true });
        return true;
      case "wp-resync":
        requestSync();
        sendResponse({ ok: true });
        return true;
      case "wp-toggle-control":
        sendToggleControl();
        sendResponse({ ok: true });
        return true;
      case "wp-state-request":
        sendResponse({ joined, room, peers, hostId, selfId, selfName, guestsCanControl, status: ui.status });
        return true;
      case "wp-href":
        // The page's own href for invite links — avoids the popup needing the
        // `tabs` permission just to read tab.url.
        sendResponse({ href: location.href });
        return true;
      default:
        return false;
    }
  });

  // ---------------------------------------------------------------- boot

  loadIdentity().then(() => {
    startVideoWatcher();
    setInterval(tick, TICK_MS);

    // An invite link in the hash (#wp=CODE) or query (?wp=CODE) auto-joins.
    const m = /[?&#]wp=([A-Z0-9]{4,10})/i.exec(location.hash + location.search);
    if (m) {
      room = m[1].toUpperCase();
      connect();
    }

    ui.setStatus("idle");
    render();
  });
})();
