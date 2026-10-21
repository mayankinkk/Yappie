const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  name: $("name"),
  idle: $("idle"),
  active: $("active"),
  create: $("create"),
  joinForm: $("joinForm"),
  code: $("code"),
  roomCode: $("roomCode"),
  roomMeta: $("roomMeta"),
  copyLink: $("copyLink"),
  leave: $("leave"),
  relay: $("relay"),
  note: $("note"),
};

let activeTabId = null;
let pollTimer = null;
let lastRoom = null;

function setNote(text) {
  els.note.hidden = !text;
  els.note.textContent = text || "";
}

function render(state) {
  const joined = !!state?.joined;
  els.status.textContent = state?.status || (joined ? "joined" : "idle");
  els.status.className = `status ${state?.status || "idle"}`;
  els.idle.hidden = joined;
  els.active.hidden = !joined;
  els.create.disabled = joined;
  els.code.disabled = joined;

  if (joined) {
    lastRoom = state.room;
    els.roomCode.textContent = state.room || "—";
    const n = state.peers?.length ?? 0;
    const role = state.selfId === state.hostId ? "you're the host" : "host controls playback";
    els.roomMeta.textContent = `${n} watching · ${role}`;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendToTab(msg) {
  if (!activeTabId) return { ok: false, error: "no_tab" };
  try {
    return await chrome.tabs.sendMessage(activeTabId, msg);
  } catch {
    return { ok: false, error: "no_content_script" };
  }
}

async function refresh() {
  if (!activeTabId) {
    render({ status: "idle" });
    setNote("Open a normal web page (not chrome://) to use WatchParty.");
    return;
  }
  const res = await sendToTab({ type: "wp-state-request" });
  if (!res || res.error === "no_content_script") {
    render({ status: "idle" });
    setNote("This page can't be synced — the extension isn't running here.");
    return;
  }
  setNote("");
  render(res);
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, 500);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function init() {
  const configured = (globalThis.WP_CONFIG && globalThis.WP_CONFIG.WS_RELAY_URL) || "";
  els.relay.placeholder = configured || "wss://your-relay.example";
  chrome.storage.local.get(["wpName", "relayUrl"], (r) => {
    if (typeof r.wpName === "string") els.name.value = r.wpName;
    // Only show an override when one was explicitly saved; otherwise fall back
    // to whatever config.js specifies.
    els.relay.value = typeof r.relayUrl === "string" ? r.relayUrl : "";
  });

  const tab = await activeTab();
  activeTabId = tab?.id ?? null;

  await refresh();
  startPolling();
}

els.name.addEventListener("change", () => {
  const v = els.name.value.trim().slice(0, 24) || "Guest";
  els.name.value = v;
  chrome.storage.local.set({ wpName: v });
});

els.relay.addEventListener("change", () => {
  const v = els.relay.value.trim();
  chrome.storage.local.set({ relayUrl: v });
});

els.create.addEventListener("click", async () => {
  els.create.disabled = true;
  const res = await sendToTab({
    type: "wp-join",
    create: true,
    name: els.name.value.trim() || "Guest",
    relayUrl: els.relay.value.trim() || undefined,
  });
  if (!res?.ok) {
    els.create.disabled = false;
    setNote(res?.error === "no_content_script" ? "This page can't be synced." : "Couldn't create a room.");
    return;
  }
  setNote("");
});

els.joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = els.code.value.trim().toUpperCase();
  if (code.length < 4) {
    setNote("Enter a room code.");
    return;
  }
  els.code.disabled = true;
  const res = await sendToTab({
    type: "wp-join",
    room: code,
    name: els.name.value.trim() || "Guest",
    relayUrl: els.relay.value.trim() || undefined,
  });
  if (!res?.ok) {
    els.code.disabled = false;
    setNote(res?.error === "no_content_script" ? "This page can't be synced." : "Couldn't join.");
    return;
  }
  setNote("");
});

els.copyLink.addEventListener("click", async () => {
  if (!lastRoom) return;
  // Ask the content script for its own href rather than reading tab.url, so
  // the extension doesn't need the `tabs` permission.
  const href = await sendToTab({ type: "wp-href" }).then((r) => r?.href).catch(() => null);
  const base = (href || "").split("#")[0];
  const link = base ? `${base}#wp=${lastRoom}` : lastRoom;
  try {
    await navigator.clipboard.writeText(link);
    setNote("Invite link copied.");
  } catch {
    setNote(`Room code: ${lastRoom}`);
  }
});

els.leave.addEventListener("click", async () => {
  await sendToTab({ type: "wp-leave" });
  lastRoom = null;
  await refresh();
});

window.addEventListener("unload", stopPolling);

init();
