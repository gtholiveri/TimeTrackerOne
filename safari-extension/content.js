// Runs in every page and reports what the page itself can see: when it becomes
// visible or hidden, URL changes (single-page apps included), title changes,
// and a beat every 15 s while visible. The relay turns these into "which page
// was on screen" and clips that to the times Safari was in front
// (server/ttserver/web.py). Records go to background.js, which uploads them.

const PAGE = Math.random().toString(36).slice(2, 10);
let seq = 0;
let lastUrl = location.href;
let lastTitle = document.title;

function record(kind) {
  return {
    src: "safari", kind, page: PAGE, seq: seq++,
    url: location.href, title: document.title, vis: document.visibilityState,
    incognito: Boolean(browser.extension && browser.extension.inIncognitoContext), ts: new Date().toISOString(),
  };
}

async function report(kind) {
  const rec = record(kind);
  try {
    await browser.runtime.sendMessage({ type: "tt", rec });
  } catch (e) {
    // Background not reachable right now: queue it, it uploads with the next batch.
    try {
      const { queue = [] } = await browser.storage.local.get("queue");
      queue.push(rec);
      await browser.storage.local.set({ queue: queue.slice(-5000) });
    } catch (_) {}
  }
}

function checkChanges() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastTitle = document.title;
    report("nav");
  } else if (document.title !== lastTitle) {
    lastTitle = document.title;
    report("title");
  }
}

if (document.visibilityState === "visible") report("show");
document.addEventListener("visibilitychange", () => report(document.visibilityState === "visible" ? "show" : "hide"));
window.addEventListener("pageshow", (e) => { if (e.persisted) report("show"); });  // back/forward cache
window.addEventListener("pagehide", () => report("hide"));
window.addEventListener("popstate", checkChanges);
window.addEventListener("hashchange", checkChanges);
document.addEventListener("DOMContentLoaded", checkChanges);
setInterval(checkChanges, 1000);
setInterval(() => { if (document.visibilityState === "visible") report("beat"); }, 15000);
