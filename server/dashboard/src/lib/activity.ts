// From ActivityWatch buckets to activity: what each device was being used for,
// as non-overlapping segments.
//
// - Laptop: window events, kept only while the AFK watcher says not-afk, with
//   the browser's tab (URL, page title) attached to browser window time.
// - Phone: the relay's window events (app, or "Home Screen"), kept only while
//   unlocked (its AFK bucket says not-afk when unlocked).

import { api, type AWEvent, type Bucket } from "./api";
import { flatten, flood, intersect, overlay, type Span } from "./intervals";

export type DeviceKind = "phone" | "desktop";

export interface Device {
  host: string;
  kind: DeviceKind;
  label: string;
  window?: string;
  afk?: string;
  web: string[];
}

export interface Seg extends Span {
  host: string;
  kind: DeviceKind;
  app: string;
  title: string;
  url?: string;
  domain?: string;
  home?: boolean; // the phone's Home Screen
  confidence?: string; // phone only: exact / tick / inferred / provisional
}

const RELAY_CLIENT = "tt-relay";
const BROWSER = /chrome|msedge|firefox|brave|opera|vivaldi|arc|safari|zen/i;
const HOME_SCREEN = "Home Screen";

/** Devices from the bucket list, phones first. Buckets without a host name
 *  (a browser extension's first minutes) are left out. */
export function discoverDevices(buckets: Record<string, Bucket>): Device[] {
  const byHost = new Map<string, Device>();
  for (const b of Object.values(buckets)) {
    if (!b.hostname || b.hostname === "unknown") continue;
    let d = byHost.get(b.hostname);
    if (!d) {
      const kind: DeviceKind = b.client === RELAY_CLIENT ? "phone" : "desktop";
      d = { host: b.hostname, kind, label: b.hostname, web: [] };
      byHost.set(b.hostname, d);
    }
    if (b.client === RELAY_CLIENT) d.kind = "phone";
    if (b.type === "currentwindow") d.window = b.id;
    else if (b.type === "afkstatus") d.afk = b.id;
    else if (b.type === "web.tab.current") d.web.push(b.id);
  }
  const devices = [...byHost.values()].filter((d) => d.window);
  const count = (k: DeviceKind) => devices.filter((d) => d.kind === k).length;
  for (const d of devices) {
    if (d.kind === "phone" && count("phone") === 1) d.label = /ipad/i.test(d.host) ? "iPad" : "iPhone";
    if (d.kind === "desktop" && count("desktop") === 1) d.label = "Laptop";
  }
  return devices.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "phone" ? -1 : 1));
}

export interface RawDevice {
  device: Device;
  window: AWEvent[];
  afk: AWEvent[];
  web: AWEvent[];
}

export async function fetchRaw(devices: Device[], start: number, end: number): Promise<RawDevice[]> {
  const get = (id?: string) => (id ? api.events(id, start, end) : Promise.resolve([]));
  return Promise.all(
    devices.map(async (device) => {
      const [window, afk, ...web] = await Promise.all([get(device.window), get(device.afk), ...device.web.map(get)]);
      return { device, window, afk, web: web.flat() };
    }),
  );
}

function span<T>(e: AWEvent, rest: T): Span & T {
  const start = Date.parse(e.timestamp);
  return { start, end: start + e.duration * 1000, ...rest };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function domainOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** One device's activity in [start, end). Each event list is flooded first
 *  (gaps under 5 s closed), as ActivityWatch's own queries do. */
export function buildSegs(raw: RawDevice, start: number, end: number): Seg[] {
  const { device } = raw;
  const windows = flood(
    flatten(
      raw.window.map((e) =>
        span(e, {
          host: device.host,
          kind: device.kind,
          app: str(e.data.app),
          title: str(e.data.title),
          home: device.kind === "phone" && e.data.app === HOME_SCREEN,
          confidence: device.kind === "phone" ? str(e.data.tt_confidence) || undefined : undefined,
        } as Omit<Seg, "start" | "end">),
      ),
      start,
      end,
    ).filter((s) => s.app),
  );
  const active = flood(flatten(raw.afk.filter((e) => e.data.status === "not-afk").map((e) => span(e, {})), start, end));
  // A phone whose AFK bucket is empty (an older relay) is trusted as is.
  const used = device.kind === "phone" && raw.afk.length === 0 ? windows : intersect(windows, active);
  const tabs = flood(
    flatten(
      raw.web.map((e) => span(e, { url: str(e.data.url), title: str(e.data.title) })),
      start,
      end,
    ).filter((t) => t.url),
  );
  return overlay(
    used,
    tabs,
    (s) => BROWSER.test(s.app),
    (piece, tab) => ({ ...piece, url: tab.url, title: tab.title || piece.title, domain: domainOf(tab.url) }),
  );
}
