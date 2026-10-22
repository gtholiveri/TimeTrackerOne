// Interval arithmetic on sorted lists of half-open spans [start, end).

export interface Span {
  start: number;
  end: number;
}

export const seconds = (s: Span) => (s.end - s.start) / 1000;

export function totalSeconds(spans: Span[]): number {
  let ms = 0;
  for (const s of spans) ms += s.end - s.start;
  return ms / 1000;
}

/** Sorted, clipped to [from, to), and with overlaps trimmed: each span ends
 *  where the next begins. Watcher heartbeats can overlap by a few ms. */
export function flatten<T extends Span>(spans: T[], from = -Infinity, to = Infinity): T[] {
  const sorted = spans
    .map((s) => (s.start < from || s.end > to ? { ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) } : s))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: T[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.end > s.start) {
      if (prev.end > s.end) continue; // fully inside the previous one
      out[out.length - 1] = { ...prev, end: s.start };
      if (out[out.length - 1].end <= out[out.length - 1].start) out.pop();
    }
    out.push(s);
  }
  return out;
}

/** Close gaps of up to `gapMs` by stretching each span to the next one, like
 *  ActivityWatch's flood(): watcher heartbeats leave small holes that aren't real. */
export function flood<T extends Span>(spans: T[], gapMs = 5_000): T[] {
  return spans.map((s, i) => {
    const next = spans[i + 1];
    return next && next.start > s.end && next.start - s.end <= gapMs ? { ...s, end: next.start } : s;
  });
}

/** The parts of `spans` inside any of `periods` (both sorted, non-overlapping). */
export function intersect<T extends Span>(spans: T[], periods: Span[]): T[] {
  const out: T[] = [];
  let j = 0;
  for (const s of spans) {
    while (j < periods.length && periods[j].end <= s.start) j++;
    for (let k = j; k < periods.length && periods[k].start < s.end; k++) {
      const start = Math.max(s.start, periods[k].start);
      const end = Math.min(s.end, periods[k].end);
      if (end > start) out.push(start === s.start && end === s.end ? s : { ...s, start, end });
    }
  }
  return out;
}

/** Split each eligible span where `cover` spans begin or end, and let `apply`
 *  enrich the pieces a cover span overlaps (both lists sorted, non-overlapping).
 *  Used to attach browser tabs to the browser's window time. */
export function overlay<T extends Span, C extends Span>(
  spans: T[],
  cover: C[],
  eligible: (s: T) => boolean,
  apply: (piece: T, c: C) => T,
): T[] {
  const out: T[] = [];
  let j = 0;
  for (const s of spans) {
    if (!eligible(s)) {
      out.push(s);
      continue;
    }
    while (j < cover.length && cover[j].end <= s.start) j++;
    let t = s.start;
    for (let k = j; k < cover.length && cover[k].start < s.end; k++) {
      const start = Math.max(s.start, cover[k].start);
      const end = Math.min(s.end, cover[k].end);
      if (end <= start) continue;
      if (start > t) out.push({ ...s, start: t, end: start });
      out.push(apply({ ...s, start, end }, cover[k]));
      t = end;
    }
    if (t < s.end) out.push(t === s.start ? s : { ...s, start: t, end: s.end });
  }
  return out;
}

/** Split spans at the given sorted boundaries (day or hour starts). */
export function splitAt<T extends Span>(spans: T[], boundaries: number[]): T[] {
  const out: T[] = [];
  for (const s of spans) {
    let start = s.start;
    for (const b of boundaries) {
      if (b <= start) continue;
      if (b >= s.end) break;
      out.push({ ...s, start, end: b });
      start = b;
    }
    out.push(start === s.start ? s : { ...s, start });
  }
  return out;
}

/** Index of the span containing t, or -1 (binary search over sorted spans). */
export function findAt<T extends Span>(spans: T[], t: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].end <= t) lo = mid + 1;
    else if (spans[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}
