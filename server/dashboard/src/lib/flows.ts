// Flow graphs for the Sankey card: where the time went (device -> category ->
// app or site) and what led to what (one block of activity -> the next).

import { subject, type CSeg } from "./aggregate";
import type { Category, CategorySet } from "./categories";
import { slotColor } from "./palette";
import { MINUTE } from "./time";

export interface FlowNode {
  id: string;
  label: string;
  title: string; // the full name, for the tooltip
  col: number;
  color: string;
  value: number;
}

export interface FlowLink {
  source: string;
  target: string;
  value: number; // what the width is: seconds, or switches
  seconds: number;
  count: number;
}

export interface FlowGraph {
  nodes: FlowNode[]; // in drawing order within each column, top first
  links: FlowLink[];
  unit: "time" | "count";
}

const OTHER = "Other";
const NEUTRAL = "var(--muted)";
const secs = (s: { start: number; end: number }) => (s.end - s.start) / 1000;
const clean = (k: string) => k.replace(/\.exe$/i, "");

function addLink(m: Map<string, FlowLink>, source: string, target: string, seconds: number, count = 1) {
  const k = `${source}\u0000${target}`;
  const l = m.get(k) ?? { source, target, value: 0, seconds: 0, count: 0 };
  l.seconds += seconds;
  l.count += count;
  m.set(k, l);
}

/** Sums each node's links (the larger of in and out, so ends of the graph count). */
function withValues(nodes: Omit<FlowNode, "value">[], links: FlowLink[]): FlowNode[] {
  const inn = new Map<string, number>();
  const out = new Map<string, number>();
  for (const l of links) {
    out.set(l.source, (out.get(l.source) ?? 0) + l.value);
    inn.set(l.target, (inn.get(l.target) ?? 0) + l.value);
  }
  return nodes
    .map((n) => ({ ...n, value: Math.max(inn.get(n.id) ?? 0, out.get(n.id) ?? 0) }))
    .filter((n) => n.value > 0);
}

/** Device -> top-level category -> app or site. Each category keeps its `topN`
 *  biggest subjects; the rest fold into "Other". With `devices` off the graph
 *  starts at the categories. */
export function whereFlow(
  segs: CSeg[],
  cats: CategorySet,
  opts: { deviceLabel?: (host: string) => string; topN?: number; devices?: boolean } = {},
): FlowGraph {
  const { deviceLabel = (h) => h, topN = 5, devices = true } = opts;
  const byCat = new Map<string, { cat: Category; seconds: number; subjects: Map<string, number> }>();
  const byHost = new Map<string, number>();
  const hostCat = new Map<string, FlowLink>();
  for (const s of segs) {
    const root = cats.root(s.cat);
    const t = secs(s);
    const c = byCat.get(root.key) ?? { cat: root, seconds: 0, subjects: new Map() };
    c.seconds += t;
    const subj = clean(subject(s));
    c.subjects.set(subj, (c.subjects.get(subj) ?? 0) + t);
    byCat.set(root.key, c);
    byHost.set(s.host, (byHost.get(s.host) ?? 0) + t);
    addLink(hostCat, `d:${s.host}`, `c:${root.key}`, t, 0);
  }

  const catOrder = [...byCat.values()].sort((a, b) => b.seconds - a.seconds);
  const nodes: Omit<FlowNode, "value">[] = [];
  const links: FlowLink[] = [];
  const col = devices ? 1 : 0;
  if (devices) {
    for (const [host] of [...byHost].sort((a, b) => b[1] - a[1])) {
      nodes.push({ id: `d:${host}`, label: deviceLabel(host), title: deviceLabel(host), col: 0, color: NEUTRAL });
    }
    links.push(...hostCat.values());
  }
  for (const { cat } of catOrder) {
    nodes.push({ id: `c:${cat.key}`, label: cat.leaf, title: cat.name.join(" › "), col, color: slotColor(cat.slot) });
  }
  for (const { cat, subjects } of catOrder) {
    const ranked = [...subjects].sort((a, b) => b[1] - a[1]);
    // Folding a single leftover into "Other" would only hide its name.
    const keep = ranked.length <= topN + 1 ? ranked : ranked.slice(0, topN);
    const rest = ranked.slice(keep.length).reduce((a, [, t]) => a + t, 0);
    for (const [subj, t] of keep) {
      const id = `s:${cat.key}\u0000${subj}`;
      nodes.push({ id, label: subj, title: `${subj} · ${cat.name.join(" › ")}`, col: col + 1, color: slotColor(cat.slot) });
      links.push({ source: `c:${cat.key}`, target: id, value: 0, seconds: t, count: 0 });
    }
    if (rest > 0) {
      const id = `s:${cat.key}\u0000`;
      const n = ranked.length - keep.length;
      nodes.push({ id, label: `${OTHER} ${cat.leaf}`, title: `${n} more in ${cat.name.join(" › ")}`, col: col + 1, color: slotColor(null) });
      links.push({ source: `c:${cat.key}`, target: id, value: 0, seconds: rest, count: 0 });
    }
  }
  for (const l of links) l.value = l.seconds;
  return { nodes: withValues(nodes, links.filter((l) => l.value > 0)), links: links.filter((l) => l.value > 0), unit: "time" };
}

/** A stretch of one category: its time is what was spent in it, not its span. */
export interface Block {
  key: string;
  start: number;
  end: number;
  seconds: number;
}

/** Joins neighbors with the same key across gaps of up to `maxGap`. */
function join(blocks: Block[], maxGap: number): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && prev.key === b.key && b.start - prev.end <= maxGap) {
      out[out.length - 1] = { ...prev, end: b.end, seconds: prev.seconds + b.seconds };
    } else out.push({ ...b });
  }
  return out;
}

/** One line of activity as blocks of a category. The Home Screen is skipped
 *  (it sits between every two phone apps), and blocks under `minBlock` are
 *  dropped so a glance at mail doesn't split an hour of work in two. */
export function blocksOf(segs: CSeg[], keyOf: (s: CSeg) => string, minBlock = MINUTE, maxGap = 15 * MINUTE): Block[] {
  const raw = segs
    .filter((s) => !s.home)
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ key: keyOf(s), start: s.start, end: s.end, seconds: secs(s) }));
  return join(join(raw, maxGap).filter((b) => b.seconds * 1000 >= minBlock), maxGap);
}

/** From -> to between consecutive blocks, as a two-column graph. Categories
 *  past the `topN` biggest fold into "Other"; switches more than `maxGap`
 *  apart (a break, the night) don't count. By time, a link is how long the
 *  destination block lasted: "Programming -> Video 2h" is two hours of video
 *  that started from programming. `perHost` reads each device as its own line
 *  (for overlapping device time); otherwise `segs` is one line already. */
export function transitionFlow(
  segs: CSeg[],
  opts: { weight?: "time" | "count"; topN?: number; minBlock?: number; maxGap?: number; perHost?: boolean; minShare?: number } = {},
): FlowGraph {
  const { weight = "time", topN = 8, minBlock = MINUTE, maxGap = 15 * MINUTE, perHost = false, minShare = 0 } = opts;
  const catByKey = new Map<string, Category>();
  for (const s of segs) catByKey.set(s.cat.key, s.cat);
  const hosts = new Map<string, CSeg[]>();
  for (const s of segs) hosts.set(s.host, [...(hosts.get(s.host) ?? []), s]);
  const lines = perHost ? [...hosts.values()] : [segs];
  const blockLines = lines.map((l) => blocksOf(l, (s) => s.cat.key, minBlock, maxGap));

  // Keep the biggest categories, by time in blocks.
  const totals = new Map<string, number>();
  for (const b of blockLines.flat()) totals.set(b.key, (totals.get(b.key) ?? 0) + b.seconds);
  const order = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const kept = new Set(order.length <= topN + 1 ? order : order.slice(0, topN));
  const fold = (k: string) => (kept.has(k) ? k : OTHER);

  const m = new Map<string, FlowLink>();
  for (const line of blockLines) {
    const bs = join(line.map((b) => ({ ...b, key: fold(b.key) })), maxGap);
    for (let i = 1; i < bs.length; i++) {
      const [a, b] = [bs[i - 1], bs[i]];
      if (b.start - a.end > maxGap || a.key === b.key) continue;
      addLink(m, `f:${a.key}`, `t:${b.key}`, b.seconds);
    }
  }
  for (const l of m.values()) l.value = weight === "time" ? l.seconds : l.count;
  // Hairlines under `minShare` of the whole are left out, as clutter.
  const all = [...m.values()].reduce((a, l) => a + l.value, 0);
  const links = [...m.values()].filter((l) => l.value >= all * minShare);

  // Both columns in the same order, so a category sits at about the same height.
  const keys = [...order.filter((k) => kept.has(k)), ...(kept.size < order.length ? [OTHER] : [])];
  const nodes: Omit<FlowNode, "value">[] = [];
  for (const col of [0, 1]) {
    for (const k of keys) {
      const cat = catByKey.get(k);
      nodes.push({
        id: `${col ? "t" : "f"}:${k}`,
        label: cat?.leaf ?? k,
        title: cat ? cat.name.join(" › ") : `${order.length - kept.size} smaller categories`,
        col,
        color: cat ? slotColor(cat.slot) : slotColor(null),
      });
    }
  }
  return { nodes: withValues(nodes, links), links, unit: weight };
}
