import { describe, expect, it } from "vitest";
import { MIN_SPAN, axisTicks, clampView, linePieces, nearestAt, zoomAt } from "./flow";
import { HOUR, MINUTE } from "./time";

const T0 = Date.UTC(2026, 0, 5, 8);
const full = { start: T0, end: T0 + 12 * HOUR };

describe("flow geometry", () => {
  it("keeps the window inside the range and no narrower than five minutes", () => {
    expect(clampView({ start: T0 - HOUR, end: T0 + HOUR }, full)).toEqual({ start: T0, end: T0 + 2 * HOUR });
    expect(clampView({ start: T0, end: T0 + 30 * HOUR }, full)).toEqual(full);
    const tiny = zoomAt(full, T0 + 6 * HOUR, 0.0001, full);
    expect(tiny.end - tiny.start).toBe(MIN_SPAN);
  });

  it("zooms around the given time", () => {
    const t = T0 + 3 * HOUR;
    const v = zoomAt(full, t, 0.5, full);
    expect(v.end - v.start).toBe(6 * HOUR);
    expect((t - v.start) / (v.end - v.start)).toBeCloseTo(0.25);
  });

  it("picks round ticks for the zoom", () => {
    expect(axisTicks(full, 1200).step).toBe(HOUR);
    const near = axisTicks({ start: T0, end: T0 + 30 * MINUTE }, 1200);
    expect(near.step).toBe(2 * MINUTE);
    expect(near.list[0]).toBe(T0);
  });

  it("folds runs narrower than a few pixels into their neighbours", () => {
    const seg = (a: number, b: number, track: number) => ({ start: T0 + a * MINUTE, end: T0 + b * MINUTE, track });
    const segs = [seg(0, 60, 0), seg(60, 61, 1), seg(61, 120, 0), seg(120, 180, 2)];
    // A day 1200 px wide is 36 s per pixel: the minute on track 1 is under 5 px.
    const out = linePieces(segs, (s) => s.track, 3, full, 1200);
    expect(out.map((p) => [(p.start - T0) / MINUTE, (p.end - T0) / MINUTE, p.track])).toEqual([[0, 120, 0], [120, 180, 2]]);
    // Zoomed to two hours, it's its own piece.
    const near = linePieces(segs, (s) => s.track, 3, { start: T0, end: T0 + 2 * HOUR }, 1200);
    expect(near.map((p) => p.track)).toEqual([0, 1, 0, 2]);
    expect(nearestAt(out, T0 + 200 * MINUTE, 30 * MINUTE)?.track).toBe(2);
    expect(nearestAt(out, T0 + 300 * MINUTE, 30 * MINUTE)).toBeNull();
  });
});
