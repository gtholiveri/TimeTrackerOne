// Background service worker for the Safari probe (test T10).
//
// Logs its own lifetime (a tick every 20 s, and a 1-minute alarm like the stock
// aw-watcher-web uses), the tab events it receives, and forwards records from
// content.js to the receiver. Anything that fails to send is kept in
// storage.local and retried with the next send.

const RECEIVER = "http://192.168.1.50:8787/log"; // <- your receiver (see docs/empirical-tests.md)

const RUN = Math.random().toString(36).slice(2, 8);
let tick = 0;
let sending = Promise.resolve();

function rec(kind, extra = {}) {
  return { src: "safari", kind, run: RUN, ts: new Date().toISOString(), ...extra };
}

// Serialize sends so the outbox is read and written by one send at a time.
function post(records) {
  sending = sending.then(async () => {
    const { outbox = [], pending = [] } = await browser.storage.local.get(["outbox", "pending"]);
    const batch = outbox.concat(pending, records);
    try {
      const res = await fetch(RECEIVER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await browser.storage.local.set({ outbox: [], pending: [] });
    } catch (e) {
      await browser.storage.local.set({ outbox: batch.slice(-1000), pending: [] });
    }
  });
  return sending;
}

async function tabRecord(kind, tab, extra = {}) {
  return rec(kind, { tab: tab.id, url: tab.url, title: tab.title, incognito: tab.incognito, ...extra });
}

post([rec("safari.bg.start")]);

setInterval(() => {
  tick += 1;
  post([rec("safari.bg.tick", { tick })]);
}, 20000);

browser.alarms.create("probe", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "probe") post([rec("safari.bg.alarm")]);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    post([await tabRecord("safari.tabs.activated", tab)]);
  } catch (e) {
    post([rec("safari.tabs.activated", { tab: tabId, err: String(e) })]);
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && changeInfo.title === undefined) return;
  post([await tabRecord("safari.tabs.updated", tab, { changed: Object.keys(changeInfo).join(",") })]);
});

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "log") {
    post([{ ...message.rec, via: "bg" }]);
    return Promise.resolve({ ok: true });
  }
  return undefined;
});
