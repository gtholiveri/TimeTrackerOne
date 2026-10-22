// The merged "you" line: at each moment, which device had your attention.
//
// The laptop's AFK watcher says when you're at it. The phone has no such
// signal, only unlocked or locked, so being unlocked isn't enough: Spotify or
// a running timer can sit on screen for hours. The rules, editable on the
// Attention tab and stored in ActivityWatch's settings ("tt_attention"):
//
// 1. A phone app on the background list never claims attention.
// 2. Otherwise the device named by `priority` wins when both are in use.
// 3. The phone's Home Screen counts only when nothing else does (if enabled).

import type { Seg } from "./activity";
import type { Span } from "./intervals";

export interface AttentionConfig {
  version: 1;
  priority: "phone" | "desktop";
  backgroundApps: string[];
  homeScreenCounts: boolean;
}

export const ATTENTION_KEY = "tt_attention";

export const DEFAULT_ATTENTION: AttentionConfig = {
  version: 1,
  priority: "phone",
  backgroundApps: ["Clock", "Spotify", "Music", "Podcasts", "Maps"],
  homeScreenCounts: true,
};

export function parseAttention(value: unknown): AttentionConfig {
  if (!value || typeof value !== "object") return DEFAULT_ATTENTION;
  const v = value as Partial<AttentionConfig>;
  return {
    version: 1,
    priority: v.priority === "desktop" ? "desktop" : "phone",
    backgroundApps: Array.isArray(v.backgroundApps) ? v.backgroundApps.filter((a) => typeof a === "string") : DEFAULT_ATTENTION.backgroundApps,
    homeScreenCounts: typeof v.homeScreenCounts === "boolean" ? v.homeScreenCounts : true,
  };
}

export function isBackground(app: string, cfg: AttentionConfig): boolean {
  const a = app.trim().toLowerCase();
  return cfg.backgroundApps.some((b) => b.trim().toLowerCase() === a);
}

/** Pick the segment that has your attention, from what each kind of device shows. */
export function choose<T extends Seg>(phone: T | null, desktop: T | null, cfg: AttentionConfig): T | null {
  const phoneApp = phone && !phone.home && !isBackground(phone.app, cfg) ? phone : null;
  const phoneHome = phone && phone.home && cfg.homeScreenCounts ? phone : null;
  const first = cfg.priority === "phone" ? phoneApp ?? desktop : desktop ?? phoneApp;
  return first ?? phoneHome;
}

/** Merge per-device activity (each list sorted, non-overlapping) into one line. */
export function mergeAttention<T extends Seg>(perDevice: T[][], cfg: AttentionConfig): T[] {
  const phones = flattenAll(perDevice.filter((l) => l[0]?.kind === "phone"));
  const desktops = flattenAll(perDevice.filter((l) => l[0]?.kind === "desktop"));
  const points = [...new Set([...phones, ...desktops].flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const out: T[] = [];
  let i = 0;
  let j = 0;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k];
    const b = points[k + 1];
    while (i < phones.length && phones[i].end <= a) i++;
    while (j < desktops.length && desktops[j].end <= a) j++;
    const p = i < phones.length && phones[i].start <= a ? phones[i] : null;
    const d = j < desktops.length && desktops[j].start <= a ? desktops[j] : null;
    const pick = choose(p, d, cfg);
    if (!pick) continue;
    const prev = out[out.length - 1];
    if (prev && prev.end === a && sameSource(prev, pick)) prev.end = b;
    else out.push({ ...pick, start: a, end: b });
  }
  return out;
}

const sameSource = (a: Seg, b: Seg) => a.host === b.host && a.app === b.app && a.title === b.title && a.url === b.url;

/** Several devices of one kind into one non-overlapping list (earlier start wins). */
function flattenAll<T extends Span>(lists: T[][]): T[] {
  if (lists.length <= 1) return lists[0] ?? [];
  const all = lists.flat().sort((a, b) => a.start - b.start);
  const out: T[] = [];
  for (const s of all) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) {
      if (s.end > prev.end) out.push({ ...s, start: prev.end });
    } else out.push(s);
  }
  return out;
}
