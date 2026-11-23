// Turns the phone's raw lines (/tt/lines) into stretches the Day view can draw:
// motion activities, place visits and GPS fixes.

import { MINUTE } from "./time";

export type Line = Record<string, string>;

/** "tt|kind=visit|ts=2026-11-23 10:34:19.336-08:00|..." -> {kind, ts, ...}. */
export function parseLine(raw: string): Line | null {
  const parts = raw.trim().split("|");
  if (parts[0] !== "tt") return null;
  const out: Line = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out.kind ? out : null;
}

/** The phone writes "2026-11-23 10:34:19.336-08:00"; Date.parse wants a T. */
export const lineTime = (s: string | undefined): number => (s ? Date.parse(s.replace(" ", "T")) : NaN);

export interface Stretch {
  start: number;
  end: number;
  what: string;
}

const MOVING = new Set(["walking", "running", "cycling", "automotive"]);

/** Motion lines are changes of activity. Each activity lasts until the next
 *  change; walking flickers to "stationary" for a few seconds at every stop,
 *  so moving stretches of the same kind closer than `bridge` are joined. Only
 *  moving stretches come back. */
export function motionStretches(lines: Line[], until: number, bridge = 3 * MINUTE): Stretch[] {
  const pts = lines
    .filter((l) => l.kind === "motion")
    .map((l) => ({ t: lineTime(l.ts), what: l.activity ?? "unknown" }))
    .filter((p) => !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t);
  const raw: Stretch[] = [];
  pts.forEach((p, i) => {
    const end = Math.min(i + 1 < pts.length ? pts[i + 1].t : until, until);
    if (MOVING.has(p.what) && end > p.t) raw.push({ start: p.t, end, what: p.what });
  });
  const out: Stretch[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && last.what === s.what && s.start - last.end <= bridge) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export interface Visit {
  start: number;
  end: number;
  ongoing: boolean;
  lat: number;
  lon: number;
  place: string; // "A", "B", ...: the same spot gets the same letter within a day
}

/** Visits from "visit" lines (arrive/depart), clipped to [from, until]. iOS
 *  reports a visit twice (on arrival with no departure, then on leaving);
 *  the later report wins. A departure in the far future means "still there". */
export function visits(lines: Line[], from: number, until: number): Visit[] {
  const byArrival = new Map<number, Line>();
  for (const l of lines) {
    if (l.kind !== "visit") continue;
    const a = lineTime(l.arrive);
    if (Number.isNaN(a)) continue;
    const prev = byArrival.get(a);
    if (!prev || lineTime(l.ts) >= lineTime(prev.ts)) byArrival.set(a, l);
  }
  const places: { lat: number; lon: number; name: string }[] = [];
  const nameOf = (lat: number, lon: number) => {
    // ~150 m counts as the same place
    const hit = places.find((p) => Math.abs(p.lat - lat) < 0.0014 && Math.abs(p.lon - lon) < 0.0017);
    if (hit) return hit.name;
    const name = String.fromCharCode(65 + (places.length % 26));
    places.push({ lat, lon, name });
    return name;
  };
  const out: Visit[] = [];
  for (const [arrive, l] of [...byArrival].sort((a, b) => a[0] - b[0])) {
    const dep = lineTime(l.depart);
    const ongoing = Number.isNaN(dep) || dep > until + 365 * 24 * 60 * MINUTE;
    const start = Math.max(arrive, from);
    const end = Math.min(ongoing ? until : dep, until);
    if (end <= start) continue;
    const lat = Number(l.lat);
    const lon = Number(l.lon);
    out.push({ start, end, ongoing, lat, lon, place: nameOf(lat, lon) });
  }
  return out;
}

/** Times of GPS fixes ("loc" lines), oldest first. */
export const fixTimes = (lines: Line[]): number[] =>
  lines.filter((l) => l.kind === "loc").map((l) => lineTime(l.ts)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);

/** Spans where location was paused ("locpause" lines with a reason), for the record. */
export const pauses = (lines: Line[]): Line[] => lines.filter((l) => l.kind === "locpause");
