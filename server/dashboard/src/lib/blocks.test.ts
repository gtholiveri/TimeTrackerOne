import { describe, expect, it } from "vitest";
import type { CSeg } from "./aggregate";
import { buildBlocks, displayName, prettySubject } from "./blocks";
import { AW_DEFAULT_CLASSES, CategorySet } from "./categories";

const set = new CategorySet(AW_DEFAULT_CLASSES);
const M = 60_000;
const T0 = Date.UTC(2026, 0, 5, 9);

/** A synthetic segment from minute a to minute b. */
function seg(a: number, b: number, app: string, title = "", url?: string): CSeg {
  const domain = url ? new URL(url).hostname : undefined;
  const s = { start: T0 + a * M, end: T0 + b * M, host: "laptop", kind: "desktop" as const, app, title, url, domain };
  return { ...s, cat: set.categorize(s) };
}

const shape = (segs: CSeg[]) =>
  buildBlocks(segs).map((b) => [(b.start - T0) / M, (b.end - T0) / M, b.label]);

describe("blocks", () => {
  it("joins one subject across short gaps and splits on idle gaps", () => {
    const out = shape([seg(0, 20, "Code.exe"), seg(22, 40, "Code.exe"), seg(70, 90, "Code.exe")]);
    expect(out).toEqual([[0, 40, "VS Code"], [70, 90, "VS Code"]]);
  });

  it("absorbs a short interruption into the block around it", () => {
    const segs = [
      seg(0, 30, "chrome.exe", "Thesis - Overleaf", "https://www.overleaf.com/project/1"),
      seg(30, 32, "Discord.exe", "general"),
      seg(32, 60, "chrome.exe", "Thesis - Overleaf", "https://www.overleaf.com/project/1"),
    ];
    const [b, ...rest] = buildBlocks(segs);
    expect(rest).toEqual([]);
    expect(b.label).toBe("Overleaf"); // the site's name from its page titles
    expect(b.items.map((i) => [i.subject, i.seconds / 60])).toEqual([["www.overleaf.com", 58], ["Discord.exe", 2]]);
    expect(b.id).toBe(`${T0}`);
  });

  it("keeps a long switch as its own block", () => {
    const out = shape([
      seg(0, 30, "Code.exe"),
      seg(30, 45, "chrome.exe", "Cat video - YouTube", "https://www.youtube.com/watch?v=1"),
      seg(45, 80, "Code.exe"),
    ]);
    expect(out.map((b) => b[2])).toEqual(["VS Code", "YouTube", "VS Code"]);
  });

  it("joins the same category and labels a pair or a mix", () => {
    // GitHub and Stack Overflow are both Work › Programming in the starter set.
    const pair = buildBlocks([
      seg(0, 20, "chrome.exe", "GitHub", "https://github.com/x"),
      seg(20, 35, "chrome.exe", "Stack Overflow", "https://stackoverflow.com/q/1"),
    ]);
    expect(pair.map((b) => b.label)).toEqual(["github.com · stackoverflow.com"]);
    expect(pair[0].cat.key).toBe("Work > Programming");
    expect(pair[0].items[0].category).toBe("Work › Programming");

    const mix = buildBlocks([
      seg(0, 3, "chrome.exe", "reddit", "https://www.reddit.com/"),
      seg(3, 5, "chrome.exe", "Twitter", "https://twitter.com/"),
      seg(5, 7, "chrome.exe", "Facebook", "https://facebook.com/"),
      seg(7, 9, "chrome.exe", "Instagram", "https://instagram.com/"),
      seg(9, 10, "chrome.exe", "devRant", "https://devrant.com/"),
    ]);
    expect(mix.map((b) => b.label)).toEqual(["Social Media · reddit.com"]);
  });

  it("lets a run of short pieces form one block when nothing long is near", () => {
    const out = shape([seg(0, 2, "Notes"), seg(2, 3, "Calculator"), seg(3, 5, "Notes"), seg(40, 41, "Notes")]);
    expect(out).toEqual([[0, 5, "Notes"], [40, 41, "Notes"]]);
  });

  it("returns nothing for nothing", () => {
    expect(buildBlocks([])).toEqual([]);
    expect(prettySubject("www.example.com")).toBe("example.com");
    expect(displayName({ subject: "www.disneyplus.com", app: "chrome.exe", title: "Andor | Disney+" })).toBe("Disney+");
    expect(displayName({ subject: "github.com", app: "chrome.exe", title: "Pull request #12 · example/tracker" })).toBe("github.com");
    expect(displayName({ subject: "SLDWORKS.exe", app: "SLDWORKS.exe", title: "" })).toBe("SolidWorks");
  });
});
