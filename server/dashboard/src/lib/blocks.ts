// Blocks: stretches of the day that were "about" one thing (writing in
// Overleaf, CAD in SolidWorks, a show on Disney+), built from the merged
// line by joining nearby segments of the same subject and absorbing short
// interruptions. Each block carries a heuristic label; the relay can replace
// it with a model-written one (see labels.ts).

import { subject, type CSeg } from "./aggregate";
import { UNCATEGORIZED, type Category } from "./categories";
import { MINUTE } from "./time";

/** One thing a block contained, with how long. Sorted longest first. */
export interface BlockItem {
  subject: string; // site for browser time, else the app (aggregate.subject)
  app: string;
  title: string; // the longest-running window / page title for this subject
  seconds: number;
  category: string; // "Work › Programming"
}

export interface Block {
  /** Stable while the block's start doesn't move, so labels survive refreshes. */
  id: string;
  start: number;
  end: number;
  segs: CSeg[];
  items: BlockItem[];
  /** The category with the most time in the block. */
  cat: Category;
  /** Heuristic label, used until (or instead of) a model-written one. */
  label: string;
}

export interface BlockOptions {
  /** Join same-subject pieces across gaps up to this long. */
  gapMs?: number;
  /** Absorb interruptions shorter than this into the surrounding block. */
  minMs?: number;
}

/** A gap with nothing in use longer than this always ends a block. */
export const IDLE_MS = 15 * MINUTE;
const GAP_MS = 5 * MINUTE;
const MIN_MS = 4 * MINUTE;

// A block under construction: its segments and the time per subject and
// category, so the dominant one is known without rescanning.
interface Group {
  start: number;
  end: number;
  segs: CSeg[];
  active: number; // ms actually in use
  bySubject: Map<string, number>;
  byCat: Map<string, { cat: Category; ms: number }>;
}

function group(s: CSeg): Group {
  const ms = s.end - s.start;
  return {
    start: s.start,
    end: s.end,
    segs: [s],
    active: ms,
    bySubject: new Map([[subject(s), ms]]),
    byCat: new Map([[s.cat.key, { cat: s.cat, ms }]]),
  };
}

function join(a: Group, b: Group): Group {
  const bySubject = new Map(a.bySubject);
  for (const [k, ms] of b.bySubject) bySubject.set(k, (bySubject.get(k) ?? 0) + ms);
  const byCat = new Map(a.byCat);
  for (const [k, v] of b.byCat) byCat.set(k, { cat: v.cat, ms: (byCat.get(k)?.ms ?? 0) + v.ms });
  return { start: a.start, end: b.end, segs: a.segs.concat(b.segs), active: a.active + b.active, bySubject, byCat };
}

/** The key with the most time (the first one on a tie). */
function top<T>(m: Map<string, T>, ms: (v: T) => number): string {
  let best = "";
  let most = -1;
  for (const [k, v] of m) {
    if (ms(v) > most) {
      best = k;
      most = ms(v);
    }
  }
  return best;
}
const topSubject = (g: Group) => top(g.bySubject, (v) => v);
const topCat = (g: Group) => g.byCat.get(top(g.byCat, (v) => v.ms))!.cat;

/** Two neighbouring groups that are about the same thing: the same main
 *  subject, or the same (named) category. */
function alike(a: Group, b: Group): boolean {
  if (topSubject(a) === topSubject(b)) return true;
  const ca = topCat(a);
  return ca.key === topCat(b).key && ca.key !== UNCATEGORIZED;
}

/** Group the merged line (sorted, non-overlapping) into blocks. */
export function buildBlocks(segs: CSeg[], opts: BlockOptions = {}): Block[] {
  const gapMs = opts.gapMs ?? GAP_MS;
  const minMs = opts.minMs ?? MIN_MS;
  const idle = Math.max(IDLE_MS, gapMs);
  const out: Block[] = [];
  // Sessions: stretches without an idle gap. Nothing joins across one.
  let session: CSeg[] = [];
  const flush = () => {
    for (const g of groupSession(session, gapMs, minMs)) out.push(toBlock(g));
    session = [];
  };
  for (const s of segs) {
    if (s.end <= s.start) continue;
    const prev = session[session.length - 1];
    if (prev && s.start - prev.end > idle) flush();
    session.push(s);
  }
  flush();
  return out;
}

function groupSession(segs: CSeg[], gapMs: number, minMs: number): Group[] {
  // 1. Runs of one subject, joined across short gaps.
  const gs: Group[] = [];
  for (const s of segs) {
    const prev = gs[gs.length - 1];
    if (prev && s.start - prev.end <= gapMs && topSubject(prev) === subject(s)) gs[gs.length - 1] = join(prev, group(s));
    else gs.push(group(s));
  }
  const near = (a: Group, b: Group) => b.start - a.end <= gapMs;

  // 2. Interruptions: the shortest run under minMs goes into a neighbour
  //    within reach (both, when they're about the same thing; otherwise the
  //    alike one, else the longer one), until none is left that can move.
  for (;;) {
    let k = -1;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      if (g.active >= minMs) continue;
      const reach = (i > 0 && near(gs[i - 1], g)) || (i + 1 < gs.length && near(g, gs[i + 1]));
      if (reach && (k < 0 || g.active < gs[k].active)) k = i;
    }
    if (k < 0) break;
    const g = gs[k];
    const prev = k > 0 && near(gs[k - 1], g) ? gs[k - 1] : null;
    const next = k + 1 < gs.length && near(g, gs[k + 1]) ? gs[k + 1] : null;
    if (prev && next && alike(prev, next)) gs.splice(k - 1, 3, join(join(prev, g), next));
    else if (prev && (!next || alike(prev, g) || (!alike(next, g) && prev.active >= next.active))) gs.splice(k - 1, 2, join(prev, g));
    else gs.splice(k, 2, join(g, next!));
  }

  // 3. Neighbours about the same thing become one block.
  const out: Group[] = [];
  for (const g of gs) {
    const prev = out[out.length - 1];
    if (prev && near(prev, g) && alike(prev, g)) out[out.length - 1] = join(prev, g);
    else out.push(g);
  }
  return out;
}

function toBlock(g: Group): Block {
  // Per subject: its app, and time per title and per category.
  const per = new Map<string, { app: string; titles: Map<string, number>; cats: Map<string, { cat: Category; ms: number }> }>();
  for (const s of g.segs) {
    const k = subject(s);
    let p = per.get(k);
    if (!p) per.set(k, (p = { app: s.app, titles: new Map(), cats: new Map() }));
    const ms = s.end - s.start;
    p.titles.set(s.title, (p.titles.get(s.title) ?? 0) + ms);
    p.cats.set(s.cat.key, { cat: s.cat, ms: (p.cats.get(s.cat.key)?.ms ?? 0) + ms });
  }
  const items: BlockItem[] = [...g.bySubject].map(([k, ms]) => {
    const p = per.get(k)!;
    return {
      subject: k,
      app: p.app,
      title: top(p.titles, (v) => v),
      seconds: ms / 1000,
      category: p.cats.get(top(p.cats, (v) => v.ms))!.cat.name.join(" › "),
    };
  });
  items.sort((a, b) => b.seconds - a.seconds);
  const cat = topCat(g);
  return { id: `${g.start}`, start: g.start, end: g.end, segs: g.segs, items, cat, label: heuristicLabel(items, cat) };
}

/** "Code.exe" -> "Code", "www.youtube.com" -> "youtube.com". */
export function prettySubject(s: string): string {
  return s.replace(/\.(exe|app)$/i, "").replace(/^www\./i, "");
}

// Windows executables whose names aren't what anyone calls them.
const APP_NAMES: Record<string, string> = {
  code: "VS Code",
  sldworks: "SolidWorks",
  winword: "Word",
  excel: "Excel",
  powerpnt: "PowerPoint",
  msedge: "Edge",
  chrome: "Chrome",
  firefox: "Firefox",
  acrobat: "Acrobat",
  explorer: "File Explorer",
  windowsterminal: "Terminal",
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** What to call an item: a site by the name its pages give it ("Andor |
 *  Disney+" on disneyplus.com -> "Disney+"), an app by its familiar name. */
export function displayName(item: Pick<BlockItem, "subject" | "app" | "title">): string {
  const pretty = prettySubject(item.subject);
  if (item.subject !== item.app) {
    const site = squash(pretty.replace(/\.[a-z]+$/i, ""));
    const parts = item.title.split(/\s+[-|·—–]\s+/);
    const name = parts.length > 1 ? parts[parts.length - 1].trim() : "";
    const n = squash(name);
    if (name && name.length <= 24 && n.length >= 3 && (site.includes(n) || n.includes(site))) return name;
    return pretty;
  }
  return APP_NAMES[squash(pretty)] ?? pretty;
}

/** The main thing; two things when they share the block; or, for a mix, the
 *  category with its main thing. */
export function heuristicLabel(items: BlockItem[], cat: Category): string {
  const [a, b] = items;
  if (!a) return cat.leaf;
  const total = items.reduce((sum, i) => sum + i.seconds, 0) || 1;
  if (!b || a.seconds / total >= 0.6) return displayName(a);
  if ((a.seconds + b.seconds) / total >= 0.6) return `${displayName(a)} · ${displayName(b)}`;
  return cat.key === UNCATEGORIZED ? `${displayName(a)} and more` : `${cat.leaf} · ${displayName(a)}`;
}
