// content.js — isolated content script world
// 1. Injects injected.js into MAIN world (MUST run at document_start)
// 2. Listens for CustomEvents from the injected script
// 3. Updates overlay DIRECTLY from SSE data (no background round-trip needed)
// 4. Also forwards SSE data to background for persistent storage
// 5. Survives SPA navigations with multi-strategy detection

const CONTAINER_ID = "__claude_counter_overlay";
const CONTEXT_LIMIT = 200_000;

// ── Safe chrome.runtime wrapper ───────────────────────────────────────────
// When the extension is reloaded/updated, old content scripts lose their
// connection to the background. All chrome.runtime calls go through here.
function extensionAlive() {
  try { return chrome.runtime?.id; } catch { return false; }
}
function safeSendMessage(msg, callback) {
  if (!extensionAlive()) return;
  try {
    chrome.runtime.sendMessage(msg, callback);
  } catch {
    // context invalidated — silently ignore
  }
}

// ── Self-destruct when context dies ───────────────────────────────────────
// When extension is reloaded, the old content script should stop doing
// everything — stop intervals, stop observers, suppress all errors.
let contextDead = false;
function shutdown() {
  contextDead = true;
}
// Catch the very first context-invalidated error and self-destruct
window.addEventListener("error", (e) => {
  if (e.message === "Extension context invalidated.") {
    e.stopImmediatePropagation();
    e.preventDefault();
    shutdown();
  }
});
// Also catch unhandled promise rejections
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.message === "Extension context invalidated.") {
    e.preventDefault();
    shutdown();
  }
});

// ── 1. Inject the fetch interceptor into MAIN world ────────────────────────
const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.onload = () => script.remove();
(document.documentElement || document.head || document.body).appendChild(script);

// ── 2. LOCAL state — overlay renders from this directly ───────────────────
// This is the key change: we keep a local copy of state and update it
// from SSE events IMMEDIATELY, without waiting for background round-trip.
let localState = {};

function mergeLocal(partial) {
  if (contextDead) return;
  localState = { ...localState, ...partial };
  renderOverlay(localState);
}

// ── 3. Listen for SSE events from injected script ─────────────────────────
// Update overlay DIRECTLY (instant) + forward to background (for storage)
window.addEventListener("__claudeCounterData", (e) => {
  const d = e.detail;

  // Direct local update — overlay refreshes immediately
  const patch = {};
  if (d.conversationTokens != null) patch.conversationTokens = d.conversationTokens;
  if (d.model) patch.model = d.model;
  if (d.cacheWriteAt) patch.cacheWriteAt = d.cacheWriteAt;
  if (d.sessionFraction != null) {
    patch.session = {
      ...(localState.session || {}),
      sseExactFraction: d.sessionFraction,
      ...(d.sessionResetsAt ? { resetsAt: d.sessionResetsAt } : {}),
    };
  }
  if (d.weeklyFraction != null) {
    patch.weekly = {
      ...(localState.weekly || {}),
      sseExactFraction: d.weeklyFraction,
      ...(d.weeklyResetsAt ? { resetsAt: d.weeklyResetsAt } : {}),
    };
  }
  if (d.sessionFraction == null && d.sessionResetsAt) {
    // Got resetsAt but no fraction — still update it
    patch.session = { ...(localState.session || {}), resetsAt: d.sessionResetsAt };
  }
  patch._sseLocal = Date.now();
  mergeLocal(patch);

  // Also forward to background for persistent storage + cross-tab sync
  safeSendMessage({ type: "SSE_DATA", data: d });
});

// ── 4. Listen for full state updates from background ──────────────────────
// Background sends this after API polls — merge into local state
try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (contextDead) return;
    if (msg.type === "STATE_UPDATE") {
      // Merge — but don't overwrite fresh SSE data with stale API data
      const s = msg.state;
      const now = Date.now();
      const freshSSE = (now - (localState._sseLocal || 0)) < 300000;

      const patch = { ...s };
      if (freshSSE) {
        // Keep our SSE-exact fractions over API fractions
        if (localState.session?.sseExactFraction != null) {
          patch.session = { ...(patch.session || {}), sseExactFraction: localState.session.sseExactFraction };
        }
        if (localState.weekly?.sseExactFraction != null) {
          patch.weekly = { ...(patch.weekly || {}), sseExactFraction: localState.weekly.sseExactFraction };
        }
      }
      mergeLocal(patch);
      try { sendResponse({ ok: true }); } catch { }
    }
  });
} catch {
  shutdown();
}

// ── 5. Initial state load from background ─────────────────────────────────
safeSendMessage({ type: "GET_STATE" }, (state) => {
  if (state && Object.keys(state).length > 0) {
    localState = { ...localState, ...state };
    renderOverlay(localState);
  }
});

safeSendMessage({ type: "TRIGGER_POLL" });

// ── SPA navigation: keep overlay alive across chat switches ─────────────
// Claude is a React SPA — switching chats does NOT reload the page.
// React can wipe our overlay DOM during re-render, so we need multiple
// strategies to detect navigation and re-create the overlay.

let lastUrl = location.href;
let navDebounce = null;

function onNavigate() {
  if (contextDead) return;
  // Debounce — React fires many mutations during one navigation
  clearTimeout(navDebounce);
  navDebounce = setTimeout(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    ensureOverlayAlive();
    // Re-render with whatever state we have locally
    renderOverlay(localState);
    // Also request fresh data from background
    safeSendMessage({ type: "TRIGGER_POLL" });
    safeSendMessage({ type: "GET_STATE" }, (state) => {
      if (state && Object.keys(state).length > 0) {
        localState = { ...localState, ...state };
        renderOverlay(localState);
      }
    });
  }, 150);
}

// Strategy 1: MutationObserver (catches most React navigations)
new MutationObserver(() => {
  if (contextDead) return;
  if (location.href !== lastUrl) onNavigate();
}).observe(document, { subtree: true, childList: true });

// Strategy 2: Intercept pushState/replaceState (catches programmatic navigation)
const _pushState = history.pushState;
const _replaceState = history.replaceState;
history.pushState = function () {
  _pushState.apply(this, arguments);
  onNavigate();
};
history.replaceState = function () {
  _replaceState.apply(this, arguments);
  onNavigate();
};
window.addEventListener("popstate", () => onNavigate());

// Strategy 3: Periodic health check — if overlay got wiped, re-create it
setInterval(() => {
  if (contextDead || !extensionAlive()) return;
  if (!document.getElementById(CONTAINER_ID)) {
    renderOverlay(localState);
  }
}, 2000);

// Strategy 4: Also re-create overlay if it exists but is detached from DOM
function ensureOverlayAlive() {
  const el = document.getElementById(CONTAINER_ID);
  if (el && !document.body?.contains(el)) {
    el.remove(); // it's orphaned — kill it so getOrCreateOverlay makes a fresh one
  }
}

// Initial trigger
ensureOverlayAlive();

// ── Overlay rendering ──────────────────────────────────────────────────────

function getOrCreateOverlay() {
  let el = document.getElementById(CONTAINER_ID);
  // If element exists but is orphaned (detached from DOM), remove it
  if (el && !document.body?.contains(el)) {
    el.remove();
    el = null;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = CONTAINER_ID;
    el.innerHTML = overlayHTML();
    (document.body || document.documentElement).appendChild(el);

    // Inject fonts via <link> (Chrome ignores @import in dynamically created <style>)
    if (!document.getElementById("__claude_counter_fonts")) {
      const link = document.createElement("link");
      link.id = "__claude_counter_fonts";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,500;1,400&family=JetBrains+Mono:wght@300;400&display=swap";
      (document.head || document.documentElement).appendChild(link);
    }

    if (!document.getElementById("__claude_counter_styles")) {
      const style = document.createElement("style");
      style.id = "__claude_counter_styles";
      style.textContent = overlayCSS();
      (document.head || document.documentElement).appendChild(style);
    }
    setupDrag(el);
    setupCollapse(el);
  }
  return el;
}

function renderOverlay(state) {
  if (contextDead || !state) return;
  const el = getOrCreateOverlay();

  const sessionFrac = state.session?.sseExactFraction ?? state.session?.fraction ?? null;
  const weeklyFrac = state.weekly?.sseExactFraction ?? state.weekly?.fraction ?? null;
  const ctxFrac = state.conversationTokens ? state.conversationTokens / CONTEXT_LIMIT : null;

  setBar(el, "#bar-session", sessionFrac);
  setBar(el, "#bar-weekly", weeklyFrac);
  setBar(el, "#bar-context", ctxFrac);

  setText(el, "#val-session", sessionFrac != null ? pct(sessionFrac) + " used" : "—");
  setText(el, "#val-weekly", weeklyFrac != null ? pct(weeklyFrac) + " used" : "—");
  setText(el, "#val-context", state.conversationTokens
    ? fmtNum(state.conversationTokens) + " / 200k"
    : "—"
  );

  if (state.model) {
    setText(el, "#val-model", formatModel(state.model));
  }

  const sessionReset = state.session?.resetsAt || state.session?.resetAt;
  if (sessionReset) {
    updateResetTimer(el, "#val-reset-session", sessionReset);
  }

  if (state.cacheWriteAt) {
    updateCacheTimer(el, "#val-cache", state.cacheWriteAt);
  }
}

function setBar(root, selector, fraction) {
  const bar = root.querySelector(selector);
  if (!bar || fraction == null) return;
  const pctVal = Math.min(100, Math.round(fraction * 100));
  bar.style.width = pctVal + "%";
  bar.style.background = barColor(fraction);
}

function setText(root, selector, text) {
  const el = root.querySelector(selector);
  if (el) el.textContent = text;
}

function barColor(f) {
  if (f > 0.85) return "oklch(0.64 0.21 25.33)";
  if (f > 0.65) return "oklch(0.69 0.16 55.00)";
  return "oklch(0.62 0.14 160.00)";
}

function pct(f) { return Math.round(f * 100) + "%"; }
function fmtNum(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }
function formatModel(m) { return m.replace("claude-", "").replace(/-\d{8}$/, ""); }

const timers = {};

function updateResetTimer(root, selector, resetAt) {
  clearInterval(timers[selector]);
  timers[selector] = setInterval(() => {
    const el = root.querySelector(selector);
    if (!el) return clearInterval(timers[selector]);
    const ms = resetAt - Date.now();
    el.textContent = ms > 0 ? "resets " + fmtCountdown(ms) : "refreshed";
  }, 1000);
}

function updateCacheTimer(root, selector, writeAt) {
  clearInterval(timers[selector]);
  const TTL = 5 * 60 * 1000;
  timers[selector] = setInterval(() => {
    const el = root.querySelector(selector);
    if (!el) return clearInterval(timers[selector]);
    const ms = (writeAt + TTL) - Date.now();
    el.textContent = ms <= 0 ? "cache expired" : "cache " + fmtCountdown(ms);
  }, 1000);
}

function fmtCountdown(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m ${s}s`;
  return `in ${s}s`;
}

// ── Drag support ───────────────────────────────────────────────────────────
function setupDrag(el) {
  const handle = el.querySelector("#cc-handle");
  let dragging = false, ox = 0, oy = 0;

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    const rect = el.getBoundingClientRect();
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    el.style.left = (e.clientX - ox) + "px";
    el.style.top = (e.clientY - oy) + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => { dragging = false; });
}

function setupCollapse(el) {
  const btn = el.querySelector("#cc-collapse");
  const body = el.querySelector("#cc-body");
  let collapsed = false;

  btn.addEventListener("click", () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "block";
    btn.textContent = collapsed ? "▲" : "▼";
  });
}

// ── HTML & CSS templates ───────────────────────────────────────────────────
function overlayHTML() {
  return `
<div id="cc-header">
  <div id="cc-handle" title="Drag to move">
    <span id="cc-title">token counter</span>
  </div>
  <div id="cc-right">
    <span id="val-model"></span>
    <button id="cc-collapse" title="Collapse">▼</button>
  </div>
</div>
<div id="cc-body">
  <div class="cc-row">
    <div class="cc-label">Session</div>
    <div class="cc-bar-wrap"><div class="cc-bar" id="bar-session"></div></div>
    <div class="cc-val" id="val-session">—</div>
  </div>
  <div class="cc-sub" id="val-reset-session"></div>

  <div class="cc-row">
    <div class="cc-label">Weekly</div>
    <div class="cc-bar-wrap"><div class="cc-bar" id="bar-weekly"></div></div>
    <div class="cc-val" id="val-weekly">—</div>
  </div>

  <div class="cc-divider"></div>

  <div class="cc-row">
    <div class="cc-label">Context</div>
    <div class="cc-bar-wrap"><div class="cc-bar" id="bar-context"></div></div>
    <div class="cc-val" id="val-context">—</div>
  </div>
  <div class="cc-sub" id="val-cache"></div>
</div>
`;
}

function overlayCSS() {
  return `#__claude_counter_overlay {
  --bg:          oklch(0.27 0.00 106.64);
  --bg-card:     oklch(0.31 0.00 106.60);
  --bg-sidebar:  oklch(0.24 0.00 67.71);
  --fg:          oklch(0.81 0.01 93.01);
  --fg-muted:    oklch(0.61 0.01 97.42);
  --fg-dim:      oklch(0.43 0.01 100.22);
  --primary:     oklch(0.67 0.13 38.76);
  --border:      oklch(0.36 0.01 106.89);
  --border-soft: oklch(0.31 0.00 106.60);
  --green:       oklch(0.62 0.14 160.00);
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483647;
  width: 232px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  font-weight: 300;
  color: var(--fg);
  box-shadow: 0 8px 32px oklch(0 0 0 / 0.5), 0 1px 0 oklch(1 0 0 / 0.04) inset;
  user-select: none;
  backdrop-filter: blur(12px);
}
#cc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 7px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
  border-radius: 10px 10px 0 0;
  cursor: grab;
  gap: 6px;
}
#cc-handle {
  cursor: grab;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}
#cc-handle::before {
  content: '';
  display: inline-block;
  width: 10px;
  height: 10px;
  background: var(--primary);
  clip-path: polygon(50% 0%, 100% 40%, 50% 100%, 0% 40%);
  opacity: 0.85;
  flex-shrink: 0;
}
#cc-title {
  font-family: 'Lora', Georgia, serif;
  font-size: 11.5px;
  font-weight: 500;
  font-style: italic;
  color: var(--fg);
  letter-spacing: 0.01em;
}
#cc-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
#val-model {
  font-family: 'JetBrains Mono', monospace !important;
  font-size: 8.5px;
  font-weight: 400;
  color: var(--fg-dim);
  background: var(--border-soft);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1.5px 4px;
  letter-spacing: 0.04em;
}
#cc-collapse {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0;
  font-size: 8px;
  line-height: 1;
  transition: color 0.15s;
}
#cc-collapse:hover { color: var(--fg); }
#cc-body { padding: 10px 10px 8px; }
.cc-row {
  display: grid;
  grid-template-columns: 46px 1fr 52px;
  align-items: center;
  gap: 7px;
  margin-bottom: 2px;
}
.cc-label {
  font-size: 9px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.cc-bar-wrap {
  height: 3px;
  background: var(--border);
  border-radius: 99px;
  overflow: hidden;
  position: relative;
}
.cc-bar {
  height: 100%;
  width: 0%;
  border-radius: 99px;
  background: var(--green);
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1), background 0.4s ease;
}
.cc-val {
  font-size: 9.5px;
  font-weight: 400;
  color: var(--fg);
  text-align: right;
  white-space: nowrap;
  letter-spacing: 0.02em;
}
.cc-sub {
  font-size: 8.5px;
  color: var(--fg-dim);
  text-align: right;
  margin-top: 1px;
  margin-bottom: 6px;
  min-height: 11px;
  padding-left: 53px;
  letter-spacing: 0.02em;
}
.cc-divider {
  height: 1px;
  background: var(--border-soft);
  margin: 6px 0;
}`;
}
