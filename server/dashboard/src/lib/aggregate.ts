// Totals, per-day series and the hour-by-weekday grid.

import type { Seg } from "./activity";
import type { Category, CategorySet } from "./categories";
import { splitAt, type Span } from "./intervals";
import { HOUR, addDays, dayStart, type Range } from "./time";

export interface CSeg extends Seg {
  cat: Category;
}

export function categorizeAll(segs: Seg[], cats: CategorySet): CSeg[] {
  return segs.map((s) => ({ ...s, cat: cats.categorize(s) }));
}

export function sumBy<T extends Span>(segs: T[], key: (s: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of segs) {
    const k = key(s);
    out.set(k, (out.get(k) ?? 0) + (s.end - s.start) / 1000);
  }
  return out;
}

export function ranked(totals: Map<string, number>): { key: string; seconds: number }[] {
  return [...totals].map(([key, seconds]) => ({ key, seconds })).sort((a, b) => b.seconds - a.seconds);
}

/** Totals per day for each key: day start -> key -> seconds. */
export function perDay<T extends Span>(segs: T[], range: Range, offsetMin: number, key: (s: T) => string) {
  const days: number[] = [];
  for (let d = dayStart(range.start, offsetMin); d < range.end; d = addDays(d, 1, offsetMin)) days.push(d);
  const pieces = splitAt(segs, days.slice(1));
  const out = new Map<number, Map<string, number>>(days.map((d) => [d, new Map()]));
  for (const p of pieces) {
    const day = out.get(dayStart(p.start, offsetMin));
    if (!day) continue;
    const k = key(p);
    day.set(k, (day.get(k) ?? 0) + (p.end - p.start) / 1000);
  }
  return { days, totals: out };
}

/** Seconds per clock hour for each hour of the range: hour start -> seconds. */
export function perHour<T extends Span>(segs: T[], range: Range, key: (s: T) => string) {
  const hours: number[] = [];
  const first = new Date(range.start);
  first.setMinutes(0, 0, 0);
  for (let h = first.getTime(); h < range.end; h += HOUR) hours.push(h);
  const pieces = splitAt(segs, hours.slice(1));
  const out = new Map<number, Map<string, number>>(hours.map((h) => [h, new Map()]));
  for (const p of pieces) {
    const d = new Date(p.start);
    d.setMinutes(0, 0, 0);
    const slot = out.get(d.getTime());
    if (!slot) continue;
    const k = key(p);
    slot.set(k, (slot.get(k) ?? 0) + (p.end - p.start) / 1000);
  }
  return { hours, totals: out };
}

/** Average active minutes per clock hour, for each weekday (Monday first). */
export function weekHourGrid(segs: Span[], range: Range): { minutes: number[][]; samples: number[] } {
  const minutes = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const hourStarts: number[] = [];
  const first = new Date(range.start);
  first.setMinutes(0, 0, 0);
  for (let h = first.getTime(); h < range.end; h += HOUR) hourStarts.push(h);
  for (const p of splitAt(segs, hourStarts.slice(1))) {
    const d = new Date(p.start);
    minutes[(d.getDay() + 6) % 7][d.getHours()] += (p.end - p.start) / 60_000;
  }
  // How many of each weekday the range covers, to average over.
  const samples = new Array<number>(7).fill(0);
  const seen = new Set<string>();
  for (const h of hourStarts) {
    const d = new Date(h);
    const k = d.toDateString();
    if (seen.has(k)) continue;
    seen.add(k);
    samples[(d.getDay() + 6) % 7]++;
  }
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) minutes[w][h] /= Math.max(1, samples[w]);
  return { minutes, samples };
}

/** Consecutive pieces of the same thing on the same device, joined across gaps
 *  of up to `gapMs` (for the activity log). */
export function coalesce(segs: CSeg[], gapMs = 5_000): CSeg[] {
  const out: CSeg[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.host === s.host && prev.app === s.app && prev.title === s.title && prev.url === s.url && s.start - prev.end <= gapMs) {
      out[out.length - 1] = { ...prev, end: s.end };
    } else out.push(s);
  }
  return out;
}

/** What a segment is "about", for grouping: the site for browser time, else the app. */
export const subject = (s: Seg) => s.domain ?? (s.home ? "Home Screen" : s.app);
