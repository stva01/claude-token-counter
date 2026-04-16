// injected.js — runs in the PAGE's JS context (MAIN world)
// Wraps window.fetch to intercept Claude's SSE response streams.
// Dispatches updates DURING streaming for real-time per-message feedback.
// Communicates back to the isolated content-script world via CustomEvent.

(function () {
  if (window.__claudeCounterInjected) return;
  window.__claudeCounterInjected = true;

  const COMPLETION_URL = /\/api\/organizations\/.+\/chat_conversations\/.+\/completion/;
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    const response = await originalFetch.apply(this, args);

    if (COMPLETION_URL.test(url)) {
      const clone = response.clone();
      processSSEStream(clone.body);
    }

    return response;
  };

  function dispatch(payload) {
    window.dispatchEvent(
      new CustomEvent("__claudeCounterData", { detail: payload })
    );
  }

  async function processSSEStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let conversationTokens = 0;
    let model = null;
    let sessionFraction = null;
    let weeklyFraction = null;
    let sessionResetsAt = null;
    let weeklyResetsAt = null;
    let cacheWriteAt = null;
    let deltaChunks = 0;

    function emitNow() {
      dispatch({
        conversationTokens,
        model: model || undefined,
        sessionFraction,
        weeklyFraction,
        sessionResetsAt,
        weeklyResetsAt,
        cacheWriteAt,
      });
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\r\n|\r|\n/);

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.substring(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let evt;
          try { evt = JSON.parse(jsonStr); } catch { continue; }

          // ── message_start — extract model name ──────────────────────────
          if (evt.type === "message_start" && evt.message) {
            // Claude now sends model as "" (empty) — skip if falsy
            if (evt.message.model) model = evt.message.model;

            // Claude no longer includes usage in message_start,
            // but check just in case older endpoints still do
            const usage = evt.message.usage;
            if (usage) {
              conversationTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
              if (usage.cache_creation_input_tokens > 0) {
                cacheWriteAt = Date.now();
              }
            }
            emitNow();
          }

          // ── message_limit — session & weekly usage fractions ─────────────
          // Claude's format changed: now uses windows.5h / windows.7d
          if (evt.type === "message_limit") {
            const lim = evt.message_limit;
            if (lim) {
              // NEW format (current): windows.5h / windows.7d
              if (lim.windows) {
                const fiveH = lim.windows["5h"];
                const sevenD = lim.windows["7d"];
                if (fiveH && fiveH.utilization != null) {
                  sessionFraction = fiveH.utilization; // already a fraction (0.16 = 16%)
                }
                if (fiveH && fiveH.resets_at != null) {
                  // resets_at is a Unix timestamp in seconds — convert to ms
                  sessionResetsAt = fiveH.resets_at * 1000;
                }
                if (sevenD && sevenD.utilization != null) {
                  weeklyFraction = sevenD.utilization;
                }
                if (sevenD && sevenD.resets_at != null) {
                  weeklyResetsAt = sevenD.resets_at * 1000;
                }
              }

              // OLD format fallback (in case some accounts still get it)
              if (sessionFraction == null && lim.remaining_tokens != null && lim.total_tokens != null) {
                sessionFraction = 1 - lim.remaining_tokens / lim.total_tokens;
              }
              if (sessionFraction == null && lim.consumed_fraction != null) {
                sessionFraction = lim.consumed_fraction;
              }
              if (weeklyFraction == null && lim.weekly_consumed_fraction != null) {
                weeklyFraction = lim.weekly_consumed_fraction;
              }

              emitNow();
            }
          }

          // ── content_block_delta — estimate tokens during streaming ───────
          if (evt.type === "content_block_delta") {
            const text = evt.delta?.text || "";
            conversationTokens += Math.ceil(text.length / 4);
            deltaChunks++;
            if (deltaChunks % 15 === 0) emitNow();
          }

          // ── message_delta — Claude no longer sends usage here, ─────────
          // but keep checking in case older endpoints still do
          if (evt.type === "message_delta" && evt.usage) {
            conversationTokens =
              (evt.usage.input_tokens || conversationTokens) +
              (evt.usage.output_tokens || 0);
            emitNow();
          }
        }
      }
    } catch (e) {
      // stream read errors are expected on navigation
    } finally {
      reader.releaseLock();
    }

    emitNow();
  }
})();
