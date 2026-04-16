// background.js — service worker
// Polls claude.ai/api/organizations/:id/usage every 3 min
// Also receives messages from content script with SSE-intercepted data

const POLL_INTERVAL_MINUTES = 3;
const USAGE_KEY = "claudeUsage";

// ── Alarm: periodic polling ────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("pollUsage", { periodInMinutes: POLL_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pollUsage") pollUsage();
});

// ── On message from content/injected scripts ───────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SSE_DATA") {
    mergeSSEData(msg.data);
    sendResponse({ ok: true });
  }
  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(USAGE_KEY, (res) => {
      sendResponse(res[USAGE_KEY] || null);
    });
    return true;
  }
  if (msg.type === "TRIGGER_POLL") {
    pollUsage().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Fetch org ID from cookie ───────────────────────────────────────────────
async function getOrgId() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: "https://claude.ai", name: "lastActiveOrg" }, (c) => {
      resolve(c ? c.value : null);
    });
  });
}

// ── Poll the official /usage endpoint ─────────────────────────────────────
async function pollUsage() {
  const orgId = await getOrgId();
  if (!orgId) return;

  try {
    const res = await fetch(
      `https://claude.ai/api/organizations/${orgId}/usage`,
      { credentials: "include" }
    );
    if (!res.ok) return;
    const data = await res.json();

    const now = Date.now();
    const current = await getState();
    const newSession = parseUsageSlot(data.five_hour);
    const newWeekly = parseUsageSlot(data.seven_day);

    const next = {
      ...current,
      officialFetchedAt: now,
      session: {
        ...newSession,
        sseExactFraction: (now - (current.sseUpdatedAt || 0) < 120000)
          ? current.session?.sseExactFraction
          : undefined,
      },
      weekly: {
        ...newWeekly,
        sseExactFraction: (now - (current.sseUpdatedAt || 0) < 120000)
          ? current.weekly?.sseExactFraction
          : undefined,
      },
      weeklySonnet: parseUsageSlot(data.seven_day_sonnet),
      weeklyOpus: parseUsageSlot(data.seven_day_opus),
      extraUsage: data.extra_usage || null,
    };
    if (next.session.sseExactFraction === undefined) delete next.session.sseExactFraction;
    if (next.weekly.sseExactFraction === undefined) delete next.weekly.sseExactFraction;
    await setState(next);
    broadcastUpdate(next);
  } catch (e) {
    // silent — will retry on next alarm
  }
}

function parseUsageSlot(slot) {
  if (!slot) return null;
  return {
    fraction: slot.utilization != null ? slot.utilization / 100 : null,
    resetsAt: slot.resets_at ? new Date(slot.resets_at).getTime() : null,
  };
}

// ── Merge SSE-intercepted data ─────────────────────────────────────────────
async function mergeSSEData(sse) {
  const current = await getState();
  const next = { ...current };

  if (sse.sessionFraction != null) {
    next.session = { ...(next.session || {}), sseExactFraction: sse.sessionFraction };
  }
  if (sse.weeklyFraction != null) {
    next.weekly = { ...(next.weekly || {}), sseExactFraction: sse.weeklyFraction };
  }
  if (sse.conversationTokens != null) next.conversationTokens = sse.conversationTokens;
  if (sse.model) next.model = sse.model;
  if (sse.cacheWriteAt) next.cacheWriteAt = sse.cacheWriteAt;
  next.sseUpdatedAt = Date.now();

  await setState(next);
  broadcastUpdate(next);
}

// ── Storage helpers ────────────────────────────────────────────────────────
async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(USAGE_KEY, (r) => resolve(r[USAGE_KEY] || {}));
  });
}

async function setState(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [USAGE_KEY]: data }, resolve);
  });
}

// ── Broadcast to all claude.ai tabs ───────────────────────────────────────
function broadcastUpdate(state) {
  chrome.tabs.query({ url: "https://claude.ai/*" }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATE", state }).catch(() => {});
    }
  });
}

pollUsage();
