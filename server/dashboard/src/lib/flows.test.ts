import { describe, expect, it } from "vitest";
import type { CSeg } from "./aggregate";
import { AW_DEFAULT_CLASSES, CategorySet } from "./categories";
import { blocksOf, transitionFlow, whereFlow } from "./flows";

const M = 60_000;
const cats = new CategorySet(AW_DEFAULT_CLASSES);

/** A synthetic segment from minute `a` to minute `b`. */
function seg(a: number, b: number, app: string, title = "", host = "laptop", extra: Partial<CSeg> = {}): CSeg {
  const base = { start: a * M, end: b * M, host, kind: "desktop" as const, app, title, ...extra };
  return { ...base, cat: cats.categorize(base) };
}

const value = (g: { links: { source: string; target: string; value: number }[] }, s: string, t: string) =>
  g.links.find((l) => l.source === s && l.target === t)?.value;

describe("whereFlow", () => {
  const segs = [
    seg(0, 60, "vim", "main.go"),
    seg(60, 90, "chrome.exe", "Cat video - YouTube", "laptop", { url: "https://www.youtube.com/watch", domain: "youtube.com" }),
    seg(90, 100, "Slack"),
    seg(100, 130, "YouTube", "", "phone"),
    seg(130, 131, "GitHub Desktop"),
    seg(131, 132, "kate"),
  ];

  it("runs device -> top-level category -> app or site, conserving time", () => {
    const g = whereFlow(segs, cats, { deviceLabel: (h) => h.toUpperCase() });
    expect(value(g, "d:laptop", "c:Work")).toBe(62 * 60);
    expect(value(g, "d:phone", "c:Media")).toBe(30 * 60);
    expect(value(g, "c:Media", "s:Media\u0000youtube.com")).toBe(30 * 60);
    expect(value(g, "c:Media", "s:Media\u0000YouTube")).toBe(30 * 60);
    expect(g.nodes.find((n) => n.id === "d:phone")?.label).toBe("PHONE");
    // Categories come in order of time, each in its palette slot.
    expect(g.nodes.filter((n) => n.col === 1).map((n) => n.id)).toEqual(["c:Work", "c:Media", "c:Comms"]);
    expect(g.nodes.find((n) => n.id === "c:Work")?.color).toBe("var(--cat-0)");
    for (const n of g.nodes.filter((n) => n.col === 1)) {
      const inn = g.links.filter((l) => l.target === n.id).reduce((a, l) => a + l.value, 0);
      const out = g.links.filter((l) => l.source === n.id).reduce((a, l) => a + l.value, 0);
      expect(inn).toBe(out);
    }
  });

  it("folds subjects past the top N into Other, and can leave devices out", () => {
    const g = whereFlow(segs, cats, { topN: 1, devices: false });
    expect(g.nodes.some((n) => n.id.startsWith("d:"))).toBe(false);
    expect(value(g, "c:Work", "s:Work\u0000vim")).toBe(60 * 60);
    expect(value(g, "c:Work", "s:Work\u0000")).toBe(2 * 60);
    expect(g.nodes.find((n) => n.id === "s:Work\u0000")?.label).toBe("Other Work");
  });
});

describe("transitionFlow", () => {
  it("drops short blocks and the Home Screen, so a glance doesn't split work", () => {
    const blocks = blocksOf(
      [seg(0, 30, "vim"), seg(30, 30.5, "Slack"), seg(30.5, 60, "kate"), seg(60, 61, "Home Screen", "", "phone", { home: true }), seg(61, 90, "YouTube")],
      (s) => s.cat.key,
    );
    expect(blocks.map((b) => [b.key, b.seconds / 60])).toEqual([["Work > Programming", 59.5], ["Media > Video", 29]]);
  });

  it("weighs a switch by the time that followed it, or counts it", () => {
    const segs = [
      seg(0, 50, "vim"), seg(50, 70, "YouTube"),
      seg(70, 100, "vim"), seg(100, 110, "YouTube"),
      seg(110, 120, "Slack"),
      // after a long break, not a switch
      seg(200, 210, "vim"),
    ];
    const byTime = transitionFlow(segs);
    expect(value(byTime, "f:Work > Programming", "t:Media > Video")).toBe(30 * 60);
    expect(value(byTime, "f:Media > Video", "t:Work > Programming")).toBe(30 * 60);
    expect(value(byTime, "f:Media > Video", "t:Comms > IM")).toBe(10 * 60);
    expect(value(byTime, "f:Comms > IM", "t:Work > Programming")).toBeUndefined();
    const byCount = transitionFlow(segs, { weight: "count" });
    expect(value(byCount, "f:Work > Programming", "t:Media > Video")).toBe(2);
    expect(byCount.unit).toBe("count");
    // Video -> IM is a seventh of all switching time: dropped at a sixth.
    expect(value(transitionFlow(segs, { minShare: 1 / 6 }), "f:Media > Video", "t:Comms > IM")).toBeUndefined();
    // Both columns list categories in the same order.
    const ids = (c: number) => byTime.nodes.filter((n) => n.col === c).map((n) => n.id.slice(2));
    expect(ids(0)).toEqual(["Work > Programming", "Media > Video"]);
    expect(ids(1)).toEqual(["Work > Programming", "Media > Video", "Comms > IM"]);
  });

  it("folds small categories into Other and reads devices apart when asked", () => {
    const segs = [
      seg(0, 60, "vim"), seg(60, 65, "Slack"), seg(65, 70, "Gmail"), seg(70, 130, "vim"),
      seg(30, 40, "YouTube", "", "phone"),
    ];
    const g = transitionFlow(segs, { topN: 1, perHost: true });
    expect(value(g, "f:Work > Programming", "t:Other")).toBe(10 * 60);
    expect(value(g, "f:Other", "t:Work > Programming")).toBe(60 * 60);
    expect(g.links).toHaveLength(2);
    // The phone's video sits on its own line, so it interrupts nothing; read
    // as one line, it splits the first block of work.
    const toVideo = (g: { links: { target: string }[] }) => g.links.some((l) => l.target === "t:Media > Video");
    expect(toVideo(transitionFlow(segs, { perHost: true }))).toBe(false);
    expect(toVideo(transitionFlow(segs))).toBe(true);
  });
});
