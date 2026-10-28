// Geometry for the zoomable timeline: the visible window and how it moves,
// axis ticks for any zoom, and the line's pieces at the current resolution
// (runs shorter than a few pixels folded into a neighbour, so a zoomed-out day
// shows its shape and a zoomed-in one every switch).

import { findAt, type Span } from "./intervals";
import { HOUR, MINUTE, fmtHour, fmtTime, type Range } from "./time";

export type View = Range;

/** The closest the timeline zooms in: five minutes across. */
export const MIN_SPAN = 5 * MINUTE;

/** The window, no wider than `full`, no narrower than MIN_SPAN, inside it. */
export function clampView(v: View, full: Range, minSpan = MIN_SPAN): View {
  const fullSpan = full.end - full.start;
  const span = Math.min(fullSpan, Math.max(Math.min(minSpan, fullSpan), v.end - v.start));
  const start = Math.min(Math.max(v.start, full.start), full.end - span);
  return { start, end: start + span };
}

/** Zoom by `factor` (below 1 zooms in) keeping time `t` where it is. */
export function zoomAt(v: View, t: number, factor: number, full: Range): View {
  const span = v.end - v.start;
  const next = Math.min(full.end - full.start, Math.max(MIN_SPAN, span * factor));
  const f = span > 0 ? (t - v.start) / span : 0.5;
  return clampView({ start: t - f * next, end: t - f * next + next }, full);
}

export const panBy = (v: View, ms: number, full: Range): View => clampView({ start: v.start + ms, end: v.end + ms }, full);

export const sameView = (a: View, b: View, slack = 1000) => Math.abs(a.start - b.start) < slack && Math.abs(a.end - b.end) < slack;

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720].map((m) => m * MINUTE);

/** Ticks on round local times, at least `minPx` apart. */
export function axisTicks(v: View, plotW: number, minPx = 64): { list: number[]; fmt: (t: number) => string; step: number } {
  const msPerPx = (v.end - v.start) / Math.max(1, plotW);
  const step = TICK_STEPS.find((s) => s / msPerPx >= minPx) ?? 12 * HOUR;
  const list: number[] = [];
  const d = new Date(v.start);
  d.setMinutes(0, 0, 0);
  if (step >= HOUR) {
    // Whole hours that are a multiple of the step on the clock (DST-safe).
    const h = step / HOUR;
    for (let t = d.getTime(); t <= v.end; t += HOUR) if (t >= v.start && new Date(t).getHours() % h === 0) list.push(t);
  } else {
    for (let t = d.getTime(); t <= v.end; t += step) if (t >= v.start) list.push(t);
  }
  return { list, fmt: step >= HOUR ? fmtHour : fmtTime, step };
}

/** A stretch of the line on one track. `share` is time per track inside it. */
export interface Piece extends Span {
  track: number;
  share: number[];
}

/** The line's pieces inside the window: runs on one track, joined across gaps
 *  under `joinMs`, with runs narrower than `minPx` folded into the larger
 *  touching neighbour (the merged piece takes the track with the most time). */
export function linePieces<T extends Span>(
  segs: T[],
  trackOf: (s: T) => number,
  tracks: number,
  v: View,
  plotW: number,
  minPx = 5,
): Piece[] {
  const msPerPx = (v.end - v.start) / Math.max(1, plotW);
  const joinMs = Math.max(60_000, 2 * msPerPx);
  const minMs = minPx * msPerPx;
  const pad = 40 * msPerPx; // pieces just outside still steer the curve in
  let i = firstEndingAfter(segs, v.start - pad);
  let runs: Piece[] = [];
  for (; i < segs.length && segs[i].start < v.end + pad; i++) {
    const s = segs[i];
    const track = trackOf(s);
    const ms = s.end - s.start;
    const prev = runs[runs.length - 1];
    if (prev && prev.track === track && s.start - prev.end <= joinMs) {
      prev.end = s.end;
      prev.share[track] += ms;
    } else {
      const share = new Array<number>(tracks).fill(0);
      share[track] = ms;
      runs.push({ start: s.start, end: s.end, track, share });
    }
  }
  const touching = (a: Piece, b: Piece) => b.start - a.end <= joinMs;
  const merge = (a: Piece, b: Piece): Piece => {
    const share = a.share.map((x, k) => x + b.share[k]);
    let track = 0;
    for (let k = 1; k < share.length; k++) if (share[k] > share[track]) track = k;
    return { start: a.start, end: b.end, track, share };
  };
  // Fold narrow runs, then join neighbours that landed on one track; repeat
  // until nothing moves (a few passes at most).
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    const out: Piece[] = [];
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k];
      const prev = out[out.length - 1];
      const next = runs[k + 1];
      if (prev && prev.track === r.track && touching(prev, r)) {
        out[out.length - 1] = merge(prev, r);
        changed = true;
      } else if (r.end - r.start < minMs) {
        const p = prev && touching(prev, r) ? prev : null;
        const n = next && touching(r, next) ? next : null;
        if (p && (!n || p.end - p.start >= n.end - n.start)) {
          out[out.length - 1] = merge(p, r);
          changed = true;
        } else if (n) {
          runs[k + 1] = merge(r, n);
          changed = true;
        } else out.push(r);
      } else out.push(r);
    }
    runs = out;
    if (!changed) break;
  }
  return runs;
}

/** Index of the first span ending after t (binary search; length if none). */
export function firstEndingAfter(spans: Span[], t: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The span at t, or the nearest one within `slack` ms (for hovering thin pieces). */
export function nearestAt<T extends Span>(spans: T[], t: number, slack: number): T | null {
  const i = findAt(spans, t);
  if (i >= 0) return spans[i];
  const k = firstEndingAfter(spans, t);
  const after = spans[k];
  const before = spans[k - 1];
  const da = after ? after.start - t : Infinity;
  const db = before ? t - before.end : Infinity;
  if (Math.min(da, db) > slack) return null;
  return da <= db ? after : before;
}

/** A smooth S from (x1, y1) to (x2, y2), level at both ends. */
export const sCurve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `C${mx.toFixed(1)},${y1.toFixed(1)} ${mx.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
};
