// A Sankey diagram for a FlowGraph: columns of nodes sized by value, joined by
// ribbons. Hovering a node or ribbon brings out its paths and fades the rest.
// Labels sit outside the first and last columns and beside the middle ones.

import { useMemo, useState, type PointerEvent, type ReactNode } from "react";
import type { FlowGraph, FlowLink, FlowNode } from "../lib/flows";
import { fmtDuration } from "../lib/time";
import { Tooltip, type TipState } from "./Tooltip";
import { useWidth } from "./useWidth";

const NODE_W = 10;
const PAD = 10; // between nodes in a column
const HEAD = 22; // column titles
const LINE = 14; // room one label needs

interface PNode extends FlowNode {
  x: number;
  y: number;
  h: number;
}

interface PLink extends FlowLink {
  i: number;
  s: PNode;
  t: PNode;
  sy: number; // top of the ribbon at each end
  ty: number;
  w: number;
}

function layout(graph: FlowGraph, width: number, height: number, gutterL: number, gutterR: number) {
  const cols = Math.max(2, ...graph.nodes.map((n) => n.col + 1));
  const byCol = Array.from({ length: cols }, (_, c) => graph.nodes.filter((n) => n.col === c));
  const plotH = height - HEAD;
  const scale = Math.min(
    ...byCol.filter((c) => c.length).map((c) => (plotH - PAD * (c.length - 1)) / c.reduce((a, n) => a + n.value, 0)),
  );
  const span = Math.max(NODE_W, width - gutterL - gutterR - NODE_W);
  const nodes = new Map<string, PNode>();
  byCol.forEach((col, c) => {
    const used = col.reduce((a, n) => a + n.value * scale, 0) + PAD * (col.length - 1);
    let y = HEAD + (plotH - used) / 2;
    for (const n of col) {
      const h = Math.max(1, n.value * scale);
      nodes.set(n.id, { ...n, x: gutterL + (span * c) / (cols - 1), y, h });
      y += n.value * scale + PAD;
    }
  });
  // Ribbons leave and arrive in the order of the node at their other end, so
  // they cross as little as they can.
  const links: PLink[] = graph.links
    .map((l, i) => ({ ...l, i, s: nodes.get(l.source)!, t: nodes.get(l.target)!, sy: 0, ty: 0, w: l.value * scale }))
    .filter((l) => l.s && l.t);
  const outY = new Map<string, number>();
  for (const l of [...links].sort((a, b) => a.t.y - b.t.y)) {
    l.sy = outY.get(l.source) ?? l.s.y;
    outY.set(l.source, l.sy + l.w);
  }
  const inY = new Map<string, number>();
  for (const l of [...links].sort((a, b) => a.s.y - b.s.y)) {
    l.ty = inY.get(l.target) ?? l.t.y;
    inY.set(l.target, l.ty + l.w);
  }
  return { nodes: [...nodes.values()], links, cols };
}

function ribbon(l: PLink): string {
  const x0 = l.s.x + NODE_W;
  const x1 = l.t.x;
  const xm = (x0 + x1) / 2;
  const w = Math.max(1, l.w);
  return `M${x0},${l.sy}C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty}V${l.ty + w}C${xm},${l.ty + w} ${xm},${l.sy + w} ${x0},${l.sy + w}Z`;
}

const clip = (s: string, chars: number) => (s.length > chars ? s.slice(0, Math.max(1, chars - 1)) + "…" : s);

type Hover = { node: string } | { link: number } | null;

export function Sankey({ graph, titles, height, gutters }: {
  graph: FlowGraph;
  titles: string[]; // one per column
  height: number;
  gutters: [number, number]; // label room left of the first column and right of the last
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const { nodes, links, cols } = useMemo(
    () => layout(graph, width, height, gutters[0], gutters[1]),
    [graph, width, height, gutters],
  );
  const fmt = (v: number) => (graph.unit === "time" ? fmtDuration(v) : `${v} switch${v === 1 ? "" : "es"}`);
  const colTotal = (c: number) => nodes.filter((n) => n.col === c).reduce((a, n) => a + n.value, 0);

  const lit = (l: PLink) =>
    !hover || ("node" in hover ? l.source === hover.node || l.target === hover.node : l.i === hover.link);
  const litNode = (n: PNode) =>
    !hover || ("node" in hover && n.id === hover.node) || links.some((l) => lit(l) && (l.source === n.id || l.target === n.id));

  // Tooltips follow the pointer, kept above the bottom so they never overhang.
  const show = (e: PointerEvent, content: ReactNode) => {
    const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: Math.min(e.clientY - box.top + 12, Math.max(0, height - 130)), content });
  };

  const linkTip = (l: PLink) => (
    <>
      <div className="t-title">{l.s.label} → {l.t.label}</div>
      {graph.unit === "count" || l.count > 0 ? (
        <>
          <div className="t-row"><span className="grow">Switches</span><span className="num">{l.count}</span></div>
          <div className="t-row"><span className="grow">Time after</span><span className="num">{fmtDuration(l.seconds)}</span></div>
          <div className="t-row muted"><span className="grow">Average stay</span><span className="num">{fmtDuration(l.seconds / Math.max(1, l.count))}</span></div>
        </>
      ) : (
        <div className="t-row"><span className="grow">Time</span><span className="num">{fmtDuration(l.seconds)}</span></div>
      )}
    </>
  );

  const nodeTip = (n: PNode) => {
    const ins = links.filter((l) => l.target === n.id).sort((a, b) => b.value - a.value);
    const outs = links.filter((l) => l.source === n.id).sort((a, b) => b.value - a.value);
    const [list, dir] = outs.length ? [outs, "→"] : [ins, "←"];
    const total = colTotal(n.col);
    return (
      <>
        <div className="t-title">{n.title}</div>
        <div className="t-row">
          <span className="grow">{fmt(n.value)}</span>
          <span className="num muted">{total ? `${Math.round((n.value / total) * 100)}%` : ""}</span>
        </div>
        {list.slice(0, 5).map((l) => {
          const other = dir === "→" ? l.t : l.s;
          return (
            <div className="t-row" key={l.i}>
              <span className="swatch" style={{ background: other.color }} />
              <span className="grow">{dir} {other.label}</span>
              <span className="num">{fmt(l.value)}</span>
            </div>
          );
        })}
        {list.length > 5 && <div className="t-row muted">and {list.length - 5} more</div>}
      </>
    );
  };

  // How much of the label room each column has, in characters.
  const mid = cols > 2 ? (width - gutters[0] - gutters[1]) / (cols - 1) - NODE_W - 20 : 0;
  const room = (n: PNode) => (n.col === 0 ? gutters[0] : n.col === cols - 1 ? gutters[1] : mid) - 8;
  const fits = (n: PNode) => n.h + PAD >= LINE;

  return (
    <div className="chart sankey" ref={ref} onPointerLeave={() => { setTip(null); setHover(null); }}>
      <svg width={width} height={height} role="img" aria-label={`Flow from ${titles[0]} to ${titles[titles.length - 1]}`}>
        {titles.map((t, c) => {
          const x = gutters[0] + ((width - gutters[0] - gutters[1] - NODE_W) * c) / Math.max(1, cols - 1);
          const anchor = c === 0 && cols > 1 ? "end" : "start";
          return (
            <text key={c} className="col-title" x={anchor === "end" ? x + NODE_W : x} y={11} textAnchor={anchor}>{t}</text>
          );
        })}
        <g className="ribbons">
          {links.map((l) => (
            <path key={l.i} d={ribbon(l)} fill={l.source.startsWith("d:") ? l.t.color : l.s.color}
              className={lit(l) ? (hover ? "on" : "") : "off"}
              onPointerEnter={(e) => { setHover({ link: l.i }); show(e, linkTip(l)); }}
              onPointerMove={(e) => show(e, linkTip(l))} />
          ))}
        </g>
        {nodes.map((n) => {
          const last = n.col === cols - 1;
          const first = n.col === 0;
          const tx = first ? n.x - 6 : n.x + NODE_W + 6;
          const chars = Math.floor((room(n) - 44) / 6.4);
          return (
            <g key={n.id} className={litNode(n) ? "node" : "node off"}
              onPointerEnter={(e) => { setHover({ node: n.id }); show(e, nodeTip(n)); }}
              onPointerMove={(e) => show(e, nodeTip(n))}>
              {/* a wider hit area than the bar itself */}
              <rect x={n.x - 4} y={n.y} width={NODE_W + 8} height={n.h} fill="transparent" />
              <rect x={n.x} y={n.y} width={NODE_W} height={n.h} rx={2} fill={n.color} />
              {fits(n) && chars > 2 && (
                <text x={tx} y={n.y + n.h / 2 + 4} textAnchor={first ? "end" : "start"} className={!first && !last ? "halo" : undefined}>
                  <tspan className="n-label">{clip(n.label, chars)}</tspan>
                  <tspan dx={5}>{fmt(n.value)}</tspan>
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}
