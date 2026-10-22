import { describe, expect, it } from "vitest";
import { buildSegs, type Device, type Seg } from "./activity";
import { DEFAULT_ATTENTION, mergeAttention } from "./attention";
import { AW_DEFAULT_CLASSES, CategorySet, forSaving, withAlternative } from "./categories";
import { findAt, flatten, intersect, overlay, splitAt } from "./intervals";
import { PALETTE_LIGHT } from "./palette";

const S = 1000;
const span = (a: number, b: number) => ({ start: a * S, end: b * S });

describe("intervals", () => {
  it("flattens overlaps and drops spans swallowed by an earlier one", () => {
    const out = flatten([{ ...span(5, 10), n: 2 }, { ...span(0, 6), n: 1 }, { ...span(7, 8), n: 3 }]);
    expect(out.map((s) => [s.start / S, s.end / S, s.n])).toEqual([[0, 5, 1], [5, 10, 2]]);
  });

  it("intersects with periods and clips", () => {
    const out = intersect([{ ...span(0, 10), n: 1 }], [span(2, 4), span(6, 20)]);
    expect(out.map((s) => [s.start / S, s.end / S])).toEqual([[2, 4], [6, 10]]);
  });

  it("overlays only eligible spans, keeping the uncovered parts", () => {
    const spans = [{ ...span(0, 10), tag: "browser" }, { ...span(10, 20), tag: "editor" }];
    const tabs = [{ ...span(3, 6), url: "a" }, { ...span(8, 15), url: "b" }];
    const out = overlay(spans, tabs, (s) => s.tag === "browser", (p, c) => ({ ...p, tag: c.url }));
    expect(out.map((s) => [s.start / S, s.end / S, s.tag])).toEqual([
      [0, 3, "browser"], [3, 6, "a"], [6, 8, "browser"], [8, 10, "b"], [10, 20, "editor"],
    ]);
  });

  it("splits at boundaries and finds by time", () => {
    const out = splitAt([span(0, 10)], [5 * S, 20 * S]);
    expect(out.map((s) => [s.start / S, s.end / S])).toEqual([[0, 5], [5, 10]]);
    expect(findAt(out, 7 * S)).toBe(1);
    expect(findAt(out, 10 * S)).toBe(-1);
  });
});

describe("categories", () => {
  const set = new CategorySet(AW_DEFAULT_CLASSES);
  const cat = (app: string, title = "", url?: string) => set.categorize({ app, title, url }).key;

  it("matches app, title or URL, deepest category winning", () => {
    expect(cat("Gmail")).toBe("Comms > Email");
    expect(cat("chrome.exe", "ActivityWatch - Google Chrome")).toBe("Work > Programming > ActivityWatch");
    // ActivityWatch's starter rule is case-sensitive, as in ActivityWatch itself.
    expect(cat("chrome.exe", "Cat video - YouTube", "https://www.youtube.com/watch")).toBe("Media > Video");
    expect(cat("chrome.exe", "x", "https://www.youtube.com/watch")).toBe("Uncategorized");
    expect(cat("Notes")).toBe("Uncategorized");
  });

  it("gives top-level categories palette slots in order, children the parent's", () => {
    const [work, media, comms] = ["Work", "Media", "Comms"].map((k) => set.byKey.get(k)!);
    expect([work.slot, media.slot, comms.slot]).toEqual([0, 1, 2]);
    expect(set.byKey.get("Media > Video")!.slot).toBe(1);
    expect(set.uncategorized.slot).toBeNull();
  });

  it("inherits the rating score", () => {
    expect(set.byKey.get("Work > Programming")!.rating).toBe("productive");
    expect(set.byKey.get("Media > Video")!.rating).toBe("neutral");
  });

  it("creates implied parents and handles Rust's (?i) flag", () => {
    const s = new CategorySet([{ name: ["Phone", "Social"], rule: { type: "regex", regex: "(?i)instagram" } }]);
    expect(s.byKey.get("Phone")!.def).toBeNull();
    expect(s.categorize({ app: "Instagram", title: "" }).key).toBe("Phone > Social");
  });

  it("extends a rule with an escaped literal", () => {
    expect(withAlternative({ type: "regex", regex: "a|b" }, "c.d").regex).toBe("a|b|c\\.d");
    expect(withAlternative({ type: "none" }, "Messages")).toEqual({ type: "regex", regex: "Messages", ignore_case: true });
  });

  it("writes each top-level hue down when saving", () => {
    const saved = forSaving(AW_DEFAULT_CLASSES, set);
    expect(saved.find((d) => d.name.join() === "Media")!.data!.color).toBe(PALETTE_LIGHT[1]);
    expect(saved.find((d) => d.name.join() === "Media,Games")!.data!.color).toBe("#F80"); // children untouched
  });
});

describe("attention", () => {
  const seg = (host: string, kind: Seg["kind"], a: number, b: number, app: string, home = false): Seg => ({
    ...span(a, b), host, kind, app, title: "", home,
  });
  const at = (out: Seg[]) => out.map((s) => [s.start / S, s.end / S, s.app]);

  it("lets the phone win, except background apps like a running timer", () => {
    const phone = [seg("p", "phone", 0, 10, "Messages"), seg("p", "phone", 10, 30, "Clock")];
    const laptop = [seg("l", "desktop", 5, 25, "code.exe")];
    expect(at(mergeAttention([phone, laptop], DEFAULT_ATTENTION))).toEqual([[0, 10, "Messages"], [10, 25, "code.exe"]]);
  });

  it("lets the laptop win when told to, and the Home Screen only fills gaps", () => {
    const phone = [seg("p", "phone", 0, 4, "Home Screen", true), seg("p", "phone", 4, 10, "Instagram")];
    const laptop = [seg("l", "desktop", 2, 8, "code.exe")];
    const out = mergeAttention([phone, laptop], { ...DEFAULT_ATTENTION, priority: "desktop" });
    expect(at(out)).toEqual([[0, 2, "Home Screen"], [2, 8, "code.exe"], [8, 10, "Instagram"]]);
  });
});

describe("activity", () => {
  const laptop: Device = { host: "L", kind: "desktop", label: "Laptop", window: "w", afk: "a", web: ["b"] };
  const ev = (t: number, d: number, data: Record<string, unknown>) => ({ timestamp: new Date(t * S).toISOString(), duration: d, data });

  it("keeps window time while not AFK and attaches the browser tab", () => {
    const segs = buildSegs(
      {
        device: laptop,
        window: [ev(0, 100, { app: "chrome.exe", title: "Chrome" }), ev(100, 100, { app: "code.exe", title: "x.ts" })],
        afk: [ev(0, 150, { status: "not-afk" }), ev(150, 50, { status: "afk" })],
        web: [ev(20, 30, { url: "https://www.youtube.com/watch?v=1", title: "A video" })],
      },
      0,
      1000 * S,
    );
    expect(segs.map((s) => [s.start / S, s.end / S, s.app, s.domain ?? null])).toEqual([
      [0, 20, "chrome.exe", null], [20, 50, "chrome.exe", "youtube.com"], [50, 100, "chrome.exe", null], [100, 150, "code.exe", null],
    ]);
  });
});
