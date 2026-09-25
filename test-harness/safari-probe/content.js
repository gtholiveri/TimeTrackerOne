// Content script for the Safari probe (test T10). Runs in every page and logs
// what the page itself can observe: load, visibility, pageshow/pagehide,
// focus/blur, URL and title changes (including single-page-app navigation), and
// a heartbeat every 15 s while visible.
//
// Every record carries a per-page id and sequence number, so the analyzer can
// count messages that never arrived.
//
// Optional: set DIRECT to an https:// receiver URL to also post straight from
// the page, bypassing the background worker. Plain http from an https page is
// blocked as mixed content.

const DIRECT = null; // e.g. "https://your-tunnel.trycloudflare.com/log"

const PAGE = Math.random().toString(36).slice(2, 8);
let seq = 0;
let lastUrl = location.href;
let lastTitle = document.title;

function rec(kind, extra = {}) {
  return {
    src: "safari", kind, page: PAGE, seq: seq++,
    url: location.href, title: document.title, vis: document.visibilityState,
    ts: new Date().toISOString(), ...extra,
  };
}

async function send(r) {
  if (DIRECT) {
    fetch(DIRECT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...r, via: "direct" }),
      keepalive: true,
    }).catch(() => {});
  }
  try {
    await browser.runtime.sendMessage({ type: "log", rec: r });
  } catch (e) {
    // Background unreachable: park it; the background sends it with its next post.
    const { pending = [] } = await browser.storage.local.get("pending");
    pending.push({ ...r, via: "pending", err: String(e) });
    await browser.storage.local.set({ pending: pending.slice(-500) });
  }
}

function checkChanges(trigger) {
  if (location.href !== lastUrl) {
    send(rec("safari.cs.url", { from: lastUrl, trigger }));
    lastUrl = location.href;
    lastTitle = document.title;
  } else if (document.title !== lastTitle) {
    send(rec("safari.cs.title", { trigger }));
    lastTitle = document.title;
  }
}

send(rec("safari.cs.load"));

document.addEventListener("visibilitychange", () => send(rec("safari.cs.visibility")));
window.addEventListener("pageshow", (e) => send(rec("safari.cs.pageshow", { persisted: e.persisted })));
window.addEventListener("pagehide", (e) => send(rec("safari.cs.pagehide", { persisted: e.persisted })));
window.addEventListener("focus", () => send(rec("safari.cs.focus")));
window.addEventListener("blur", () => send(rec("safari.cs.blur")));
window.addEventListener("popstate", () => checkChanges("popstate"));
window.addEventListener("hashchange", () => checkChanges("hashchange"));

setInterval(() => checkChanges("poll"), 1000);
setInterval(() => {
  if (document.visibilityState === "visible") send(rec("safari.cs.beat"));
}, 15000);
