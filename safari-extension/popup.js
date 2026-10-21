const $ = (id) => document.getElementById(id);

async function show() {
  const s = await browser.storage.local.get(["relay", "key", "dev", "queue", "lastOk", "lastError"]);
  $("relay").value = s.relay || "";
  $("key").value = s.key || "";
  $("dev").value = s.dev || "";
  const lines = [`Waiting to upload: ${(s.queue || []).length}`];
  lines.push(`Last upload: ${s.lastOk ? new Date(s.lastOk).toLocaleString() : "never"}`);
  if (s.lastError) lines.push(`Last error: ${s.lastError}`);
  $("status").textContent = lines.join("\n");
}

$("save").addEventListener("click", async () => {
  let relay = $("relay").value.trim();
  let key = $("key").value.trim();
  try {
    // Accept the TT Sync URL as is: https://host/tt/ingest?key=...
    const u = new URL(relay);
    if (u.searchParams.get("key")) key = key || u.searchParams.get("key");
    relay = u.origin;
  } catch (_) {}
  await browser.storage.local.set({ relay, key, dev: $("dev").value.trim() });
  await browser.runtime.sendMessage({ type: "flush" }).catch(() => {});
  show();
});

show();
