import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the page talks to the real relay through Vite, which adds the
// key on the way out, so the browser never sees it. Set TT_RELAY and TT_KEY, or
// leave them in ~/tt-relay-keys.txt, where deploy/fly-setup.ps1 writes them.
function relayConfig(): { relay?: string; key?: string } {
  let relay = process.env.TT_RELAY;
  let key = process.env.TT_KEY;
  if (!relay || !key) {
    try {
      const text = readFileSync(join(homedir(), "tt-relay-keys.txt"), "utf8");
      relay ??= text.match(/TimeTracker relay:\s*(\S+)/)?.[1];
      key ??= text.match(/^TT_KEY\s+(\S+)/m)?.[1];
    } catch {
      // No keys file: the dev server runs without a relay.
    }
  }
  return { relay, key };
}

export default defineConfig(({ command }) => {
  const { relay, key } = command === "serve" ? relayConfig() : {};
  const target = relay && {
    target: relay,
    changeOrigin: true,
    headers: key ? { Authorization: "Basic " + Buffer.from(`dev:${key}`).toString("base64") } : {},
    // The relay turns away other sites' Origin; this request is ours.
    configure: (proxy: { on: (event: "proxyReq", fn: (req: { removeHeader: (h: string) => void }) => void) => void }) =>
      proxy.on("proxyReq", (req) => req.removeHeader("origin")),
  };
  return {
    base: "/app/",
    plugins: [react()],
    server: target ? { proxy: { "/api": target, "/tt": target } } : {},
  };
});
