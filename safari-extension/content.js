// Runs in every page and reports what the page itself can see: when it becomes
// visible or hidden, URL changes (single-page apps included), title changes,
// and a beat every 15 s while visible. The relay turns these into "which page
// was on screen" and clips that to the times Safari was in front
// (server/ttserver/web.py).
//
// Each record is posted straight to the relay from here. Safari on iOS
// suspends extension background scripts aggressively, so the page itself is
// the reliable sender. If that fails (offline, or a site's security policy
// blocks the request), the record goes to background.js, which queues it and
// retries.

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

async function direct(rec) {
  const { relay = "", key = "", dev = "" } = await browser.storage.local.get(["relay", "key", "dev"]);
  if (!relay || !key) return false;
  const url = `${relay.replace(/\/+$/, "")}/tt/safari?key=${encodeURIComponent(key)}` +
    (dev ? `&dev=${encodeURIComponent(dev)}` : "");
  try {
    // text/plain keeps it a "simple" request (no CORS preflight); keepalive
    // lets the "hide" record finish sending while the page goes away.
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify([rec]), keepalive: true,
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function report(kind) {
  const rec = record(kind);
  if (await direct(rec)) return;
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
