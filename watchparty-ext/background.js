/**
 * Background service worker.
 *
 * Thin relay between the popup and whichever tab currently has a room. Holds
 * no sync state — the content script owns the socket; this only mirrors the
 * badge.
 */

/** @type {Map<number, { joined: boolean, room: string|null, peerCount: number, status: string }>} */
const tabState = new Map();

function setBadge(tabId, state) {
  const joined = !!state?.joined;
  const text = joined ? String(state.peerCount || 0) : "";
  const color = joined ? "#34d399" : "#9ca3af";
  void chrome.action.setBadgeText({ tabId, text });
  void chrome.action.setBadgeBackgroundColor({ tabId, color });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "wp-state") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      tabState.set(tabId, msg);
      setBadge(tabId, msg);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "wp-state-for-tab") {
    sendResponse(tabState.get(msg.tabId) || { joined: false, status: "idle" });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

// Badge state doesn't survive a service-worker restart, so re-ask any tab that
// might still be connected when we come back up.
chrome.runtime.onStartup.addListener(() => {
  tabState.clear();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const state = tabState.get(tabId);
  if (state) setBadge(tabId, state);
});
