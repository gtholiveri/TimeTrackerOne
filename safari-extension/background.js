// Collects records from content.js and uploads them to the relay's /tt/safari
// endpoint in batches. Anything that fails to upload stays queued in
// storage.local and goes with the next batch (retried every minute).
// The relay URL and key are set in the popup (popup.html).

// Every read-modify-write of the queue runs on this one chain, so records
// arriving during an upload aren't lost.
let chain = Promise.resolve();
let timer = null;

function serial(fn) {
  chain = chain.then(fn, fn);
  return chain;
}

async function settings() {
  const { relay = "", key = "", dev = "" } = await browser.storage.local.get(["relay", "key", "dev"]);
  return { relay: relay.replace(/\/+$/, ""), key, dev };
}

function enqueue(rec) {
  return serial(async () => {
    const { queue = [] } = await browser.storage.local.get("queue");
    queue.push(rec);
    await browser.storage.local.set({ queue: queue.slice(-5000) });
    // A short delay batches a burst (load, nav, title) into one upload.
    clearTimeout(timer);
    timer = setTimeout(flush, 1500);
  });
}

function flush() {
  return serial(async () => {
    const { relay, key, dev } = await settings();
    const { queue = [] } = await browser.storage.local.get("queue");
    if (!relay || !key || queue.length === 0) return;
    const batch = queue.slice(0, 500);
    const url = `${relay}/tt/safari?key=${encodeURIComponent(key)}` + (dev ? `&dev=${encodeURIComponent(dev)}` : "");
    try {
      // text/plain keeps this a "simple" request: no CORS preflight.
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(batch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { queue: current = [] } = await browser.storage.local.get("queue");
      const rest = current.slice(batch.length);
      await browser.storage.local.set({ queue: rest, lastOk: Date.now(), lastError: "" });
      if (rest.length) setTimeout(flush, 0);
    } catch (e) {
      await browser.storage.local.set({ lastError: `${new Date().toLocaleTimeString()}: ${e}` });
    }
  });
}

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "tt") {
    return enqueue(message.rec).then(() => ({ ok: true }));
  }
  if (message && message.type === "flush") {
    return flush().then(() => ({ ok: true }));
  }
  return undefined;
});

browser.alarms.create("tt-retry", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "tt-retry") flush(); });
flush();
