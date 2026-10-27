import { describe, expect, it } from "vitest";
import type { BlockItem } from "./blocks";
import { contentKey, contentNorm } from "./labels";

const item = (subject: string, seconds: number, title = "", app = subject): BlockItem => ({
  subject,
  app,
  title,
  seconds,
  category: "Work",
});

const WRITING = [item("overleaf.com", 1500, "Lab report - Online LaTeX Editor", "Chrome"), item("Slack", 200, "general")];

describe("block content key", () => {
  it("matches the relay's normalization", () => {
    // Same strings as server/tests/test_labels.py expects from content_norm.
    expect(contentNorm(WRITING)).toBe("overleaf.com|lab report online latex editor");
    const show = [item("disneyplus.com", 2400, "Andor | Disney+", "Chrome"), item("Slack", 900, "#general (2)")];
    expect(contentNorm(show)).toBe("disneyplus.com|andor disney\nslack|general");
  });

  it("stays put while a block grows or a counter ticks", () => {
    const base = contentKey(WRITING);
    expect(contentKey([{ ...WRITING[0], seconds: 1700 }, { ...WRITING[1], seconds: 180 }])).toBe(base);
    expect(contentKey([{ ...WRITING[0], title: "(3) Lab report - Online LaTeX Editor" }, WRITING[1]])).toBe(base);
    expect(contentKey([...WRITING, item("Spotify", 20, "song")])).toBe(base);
    expect(contentKey([WRITING[1], WRITING[0]])).toBe(base); // input order doesn't matter
  });

  it("changes with what the block was about", () => {
    const base = contentKey(WRITING);
    expect(contentKey([item("SOLIDWORKS", 3000, "bracket.SLDPRT")])).not.toBe(base);
    expect(contentKey([WRITING[0], { ...WRITING[1], seconds: 1500 }])).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });
});
