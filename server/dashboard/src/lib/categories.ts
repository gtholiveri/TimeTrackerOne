// Categories in ActivityWatch's own format (the "classes" setting), so its web
// UI and this dashboard share them. Each has a nested name, a regex rule, and
// data.color / data.score. Score is the rating: above 0 productive, below 0
// distracting; a subcategory without its own inherits its parent's.
//
// Matching follows aw-server-rust's categorize(): a rule tests the event's text
// fields (app, title, URL); of all matching categories the deepest wins, and a
// later one wins a tie.

import type { Seg } from "./activity";
import { PALETTE_LIGHT, slotOf } from "./palette";

export interface Rule {
  type?: "regex" | "none" | null;
  regex?: string;
  ignore_case?: boolean;
}

export interface ClassDef {
  id?: number;
  name: string[];
  rule: Rule;
  data?: { color?: string; score?: number; [k: string]: unknown };
}

export type Rating = "productive" | "neutral" | "distracting";

export const RATING_SCORE: Record<Rating, number> = { productive: 10, neutral: 0, distracting: -10 };

export interface Category {
  key: string;
  name: string[];
  leaf: string;
  depth: number;
  parentKey: string | null;
  def: ClassDef | null; // null: a parent implied by a subcategory's name
  index: number;
  slot: number | null;
  score: number | null;
  rating: Rating;
  matcher: RegExp | null;
  error?: string;
}

export const UNCATEGORIZED = "Uncategorized";
export const keyOf = (name: string[]) => name.join(" > ");

// ActivityWatch's starter categories (aw-webui 0.13), used until any are saved.
export const AW_DEFAULT_CLASSES: ClassDef[] = [
  { name: ["Work"], rule: { type: "regex", regex: "Google Docs|libreoffice|ReText" }, data: { color: "#0F0", score: 10 } },
  { name: ["Work", "Programming"], rule: { type: "regex", regex: "GitHub|Stack Overflow|BitBucket|Gitlab|vim|Spyder|kate|Ghidra|Scite" } },
  { name: ["Work", "Programming", "ActivityWatch"], rule: { type: "regex", regex: "ActivityWatch|aw-", ignore_case: true } },
  { name: ["Work", "Image"], rule: { type: "regex", regex: "GIMP|Inkscape" } },
  { name: ["Work", "Video"], rule: { type: "regex", regex: "Kdenlive" } },
  { name: ["Work", "Audio"], rule: { type: "regex", regex: "Audacity" } },
  { name: ["Work", "3D"], rule: { type: "regex", regex: "Blender" } },
  { name: ["Media"], rule: { type: "none" }, data: { color: "#F33" } },
  { name: ["Media", "Games"], rule: { type: "regex", regex: "Minecraft|RimWorld" }, data: { color: "#F80" } },
  { name: ["Media", "Video"], rule: { type: "regex", regex: "YouTube|Plex|VLC" }, data: { color: "#F33" } },
  { name: ["Media", "Social Media"], rule: { type: "regex", regex: "reddit|Facebook|Twitter|Instagram|devRant", ignore_case: true }, data: { color: "#FCC400" } },
  { name: ["Media", "Music"], rule: { type: "regex", regex: "Spotify|Deezer", ignore_case: true }, data: { color: "#A8FC00" } },
  { name: ["Comms"], rule: { type: "none" }, data: { color: "#9FF" } },
  { name: ["Comms", "IM"], rule: { type: "regex", regex: "Messenger|Telegram|Signal|WhatsApp|Rambox|Slack|Riot|Element|Discord|Nheko|NeoChat|Mattermost" } },
  { name: ["Comms", "Email"], rule: { type: "regex", regex: "Gmail|Thunderbird|mutt|alpine" } },
  { name: [UNCATEGORIZED], rule: { type: null }, data: { color: "#CCC" } },
];

export function compileRule(rule: Rule): { matcher: RegExp | null; error?: string } {
  if (rule.type !== "regex" || !rule.regex) return { matcher: null };
  let source = rule.regex;
  let flags = rule.ignore_case ? "i" : "";
  if (source.startsWith("(?i)")) {
    source = source.slice(4); // Rust's inline flag; JavaScript has no equivalent
    flags = "i";
  }
  try {
    return { matcher: new RegExp(source, flags) };
  } catch (e) {
    return { matcher: null, error: (e as Error).message };
  }
}

export const ratingOf = (score: number | null): Rating =>
  score === null || score === 0 ? "neutral" : score > 0 ? "productive" : "distracting";

export class CategorySet {
  readonly list: Category[]; // tree order: each parent followed by its children
  readonly byKey: Map<string, Category>;
  readonly uncategorized: Category;
  private memo = new Map<string, Category>();

  constructor(defs: ClassDef[]) {
    const byKey = new Map<string, Category>();
    const order: Category[] = [];
    const add = (name: string[], def: ClassDef | null, index: number) => {
      const key = keyOf(name);
      const existing = byKey.get(key);
      if (existing) {
        if (def && !existing.def) Object.assign(existing, { def, index, ...compileRule(def.rule) });
        return existing;
      }
      if (name.length > 1) add(name.slice(0, -1), null, index);
      const cat: Category = {
        key,
        name,
        leaf: name[name.length - 1],
        depth: name.length - 1,
        parentKey: name.length > 1 ? keyOf(name.slice(0, -1)) : null,
        def,
        index,
        slot: null,
        score: null,
        rating: "neutral",
        ...(def ? compileRule(def.rule) : { matcher: null }),
      };
      byKey.set(key, cat);
      order.push(cat);
      return cat;
    };
    defs.forEach((def, i) => add(def.name, def, i));
    if (!byKey.has(UNCATEGORIZED)) add([UNCATEGORIZED], null, defs.length);

    // Hues: a top-level category keeps a palette color it was saved with;
    // the others take the free slots in order.
    const tops = order.filter((c) => c.depth === 0 && c.key !== UNCATEGORIZED);
    const taken = new Set<number>();
    for (const c of tops) {
      const s = slotOf(c.def?.data?.color);
      if (s !== null) {
        c.slot = s;
        taken.add(s);
      }
    }
    let next = 0;
    for (const c of tops) {
      if (c.slot !== null) continue;
      while (taken.has(next)) next++;
      if (next < PALETTE_LIGHT.length) {
        c.slot = next;
        taken.add(next);
      }
    }
    // Tree order, inherited hue and score.
    const children = (key: string | null) => order.filter((c) => c.parentKey === key);
    const list: Category[] = [];
    const walk = (c: Category, parent: Category | null) => {
      if (parent) c.slot = parent.slot;
      const own = c.def?.data?.score;
      c.score = typeof own === "number" ? own : parent ? parent.score : null;
      c.rating = ratingOf(c.score);
      list.push(c);
      for (const child of children(c.key)) walk(child, c);
    };
    for (const top of children(null).filter((c) => c.key !== UNCATEGORIZED)) walk(top, null);
    const unc = byKey.get(UNCATEGORIZED)!;
    unc.slot = null;
    walk(unc, null);

    this.list = list;
    this.byKey = byKey;
    this.uncategorized = unc;
  }

  get top(): Category[] {
    return this.list.filter((c) => c.depth === 0);
  }

  parent(c: Category): Category | null {
    return c.parentKey ? this.byKey.get(c.parentKey) ?? null : null;
  }

  /** The top-level category above (or equal to) c. */
  root(c: Category): Category {
    return this.byKey.get(c.name[0]) ?? c;
  }

  categorize(seg: Pick<Seg, "app" | "title" | "url">): Category {
    const memoKey = `${seg.app}\u0000${seg.title}\u0000${seg.url ?? ""}`;
    const hit = this.memo.get(memoKey);
    if (hit) return hit;
    const fields = [seg.app, seg.title, seg.url ?? ""];
    let best: Category | null = null;
    for (const c of this.list) {
      if (!c.matcher || !fields.some((f) => f && c.matcher!.test(f))) continue;
      if (!best || c.depth > best.depth || (c.depth === best.depth && c.index >= best.index)) best = c;
    }
    const result = best ?? this.uncategorized;
    this.memo.set(memoKey, result);
    return result;
  }
}

/** Escape text for use as a literal inside a regex alternative. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Add `literal` as one more alternative to a rule's regex. */
export function withAlternative(rule: Rule, literal: string): Rule {
  const alt = escapeRegex(literal);
  if (rule.type !== "regex" || !rule.regex) return { type: "regex", regex: alt, ignore_case: true };
  return { ...rule, regex: `${rule.regex}|${alt}` };
}

/** The defs as ActivityWatch stores them, with every top-level category's hue
 *  written down so ActivityWatch's own web UI shows the same colors. */
export function forSaving(defs: ClassDef[], set: CategorySet): ClassDef[] {
  return defs.map((d) => {
    const cat = set.byKey.get(keyOf(d.name));
    if (!cat || cat.depth !== 0 || cat.slot === null || cat.key === UNCATEGORIZED) return d;
    return { ...d, data: { ...d.data, color: PALETTE_LIGHT[cat.slot] } };
  });
}
