// The day as a stream you can move along. Three views share one zoomable
// window: Flow (one thick, Sankey-like stream that rises and falls between
// category tracks, from work at the top to media at the bottom, with what each
// stretch was about written above it; time away fades it out), Blocks (the
// day as labeled bars, like a calendar) and Devices (the same tracks with a
// thinner stream per device, unfused). Wheel or pinch zooms around the pointer, drag pans, and panning
// carries on across midnight into the days either side (the caller loads them
// as the window nears them). The strip underneath shows the day the window is
// in, and clicking a block zooms to it. Nothing here changes size on hover.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { subject, type CSeg } from "../lib/aggregate";
import { buildBlocks, displayName, type Block } from "../lib/blocks";
import type { Category } from "../lib/categories";
import {
  MIN_SPAN, axisTicks, clampView, firstEndingAfter, linePieces, nearestAt, panBy, sCurve, sameView, zoomAt, type Piece, type View,
} from "../lib/flow";
import { useBlockLabels } from "../lib/labels";
import { slotColor } from "../lib/palette";
import { useApp } from "../lib/store";
import { DAY, MINUTE, daysIn, fmtDuration, fmtShortDay, fmtTime, type Range } from "../lib/time";
import { SegTip, type TimelineLane } from "./Timeline";
import { Tooltip, type TipState } from "./Tooltip";
import { usePref } from "./usePref";
import { useWidth } from "./useWidth";

type Mode = "flow" | "blocks" | "devices";

interface Props {
  title: ReactNode;
  /** The merged line. */
  segs: CSeg[];
  /** One lane per device, for the Devices view. */
  lanes: TimelineLane[];
  /** How far the window can move: the days loaded, up to now. */
  bounds: Range;
  /** The day's stretch: the first window, "Fit day", and the strip below. */
  fit: Range;
  /** Changes when the caller moves to another day; the window goes to `fit`. */
  jump?: number;
  /** Told the window after every move. */
  onView?: (view: View) => void;
  now?: number;
  deviceLabel?: (host: string) => string;
}

/** The widest the window zooms out to. */
const MAX_SPAN = DAY;

// Flow geometry: room for labels above the first track, track spacing, the
// stream's thickness (merged, and per device when unfused).
const TOP = 34;
const TRACK = 44;
const BAND = 16;
const DEVICE_BAND = 9;
const AXIS = 24;
const MINI = 30;
const CURVE = 26; // half-width of the S between touching pieces: wide, like a Sankey link
const AWAY_MS = 10 * MINUTE; // gaps at least this long fade the stream out
const FADE = 18; // px over which it fades

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const LABEL_FONT = `500 11.5px ${FONT}`;
const SUB_FONT = `10.5px ${FONT}`;
const BAR_FONT = `500 12px ${FONT}`;
const NAME_FONT = `12px ${FONT}`;

export function FlowTimeline({ title, segs, lanes, bounds: givenBounds, fit: givenFit, jump = 0, onView, now, deviceLabel }: Props) {
  const { cats, dayOffset } = useApp();
  // Callers build ranges each render; one object per value keeps the memos below.
  const bounds = useMemo(() => ({ start: givenBounds.start, end: givenBounds.end }), [givenBounds.start, givenBounds.end]);
  const range = useMemo(() => ({ start: givenFit.start, end: givenFit.end }), [givenFit.start, givenFit.end]);
  const [mode, setMode] = usePref<Mode>("today.timeline", "flow");
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, "");
  // Tracks: the top-level categories in the day, by how good they are: work
  // at the top, comms, other in the middle, media at the bottom.
  const tracks = useMemo(() => {
    const roots = new Map<string, Category>();
    for (const s of [...segs, ...lanes.flatMap((l) => l.segs)]) {
      const r = cats.root(s.cat);
      roots.set(r.key, r);
    }
    const order = (c: Category) => goodness(c, c === cats.uncategorized);
    return [...roots.values()].sort((a, b) => order(b) - order(a) || cats.list.indexOf(a) - cats.list.indexOf(b));
  }, [segs, lanes, cats]);
  const trackIndex = useMemo(() => new Map(tracks.map((c, i) => [c.key, i])), [tracks]);
  const trackOf = useMemo(() => (s: CSeg) => trackIndex.get(cats.root(s.cat).key) ?? 0, [trackIndex, cats]);
  const colors = tracks.map((c) => slotColor(c.slot));
  const trackName = (c: Category) => (c === cats.uncategorized ? "Other" : c.leaf);

  // The names column: as wide as the longest name it shows, within limits.
  const names = mode === "blocks" ? [0] : tracks.map((c) => textWidth(trackName(c), NAME_FONT) + 14);
  const gutter = Math.round(Math.min(width * 0.3, 110, Math.max(36, ...names) + 10));
  const plotW = Math.max(40, width - gutter);
  const { view, set, animateTo } = useViewport(bounds, range, jump);
  const clamp = (v: View) => clampView(v, bounds, MIN_SPAN, MAX_SPAN);
  const zoom = (v: View, t: number, factor: number) => zoomAt(v, t, factor, bounds, MAX_SPAN);
  const pan = (v: View, ms: number) => panBy(v, ms, bounds);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => onViewRef.current?.(view), [view.start, view.end]);
  const span = view.end - view.start;
  const x = (t: number) => gutter + ((t - view.start) / span) * plotW;
  const tAt = (px: number) => view.start + ((px - gutter) / plotW) * span;

  const blocks = useMemo(() => buildBlocks(segs), [segs]);
  const labels = useBlockLabels(blocks);
  // Per block: its time in use and the track it mostly sat on.
  const blockInfo = useMemo(
    () =>
      new Map(
        blocks.map((b) => {
          const share = new Array<number>(Math.max(1, tracks.length)).fill(0);
          for (const s of b.segs) share[trackOf(s)] += s.end - s.start;
          return [b.id, { active: share.reduce((a, c) => a + c, 0) / 1000, track: share.indexOf(Math.max(...share)) }];
        }),
      ),
    [blocks, trackOf, tracks.length],
  );

  const pieces = useMemo(() => linePieces(segs, trackOf, Math.max(1, tracks.length), view, plotW), [segs, trackOf, tracks.length, view, plotW]);
  // What the Flow and Devices views draw: one stream, or one per device side
  // by side (the first device on top), each with its own pieces.
  const streams = useMemo<Stream[]>(() => {
    if (mode !== "devices") return [{ label: "", segs, pieces, h: BAND, dy: 0 }];
    const n = lanes.length;
    return lanes.map((l, i) => ({
      label: l.label,
      segs: l.segs,
      pieces: linePieces(l.segs, trackOf, Math.max(1, tracks.length), view, plotW),
      h: DEVICE_BAND,
      dy: (i - (n - 1) / 2) * (DEVICE_BAND + 1.5),
    }));
  }, [mode, segs, pieces, lanes, trackOf, tracks.length, view, plotW]);
  const ticks = useMemo(() => axisTicks(view, plotW, width < 520 ? 58 : 72), [view, plotW, width]);

  // Heights per view.
  const ys = tracks.map((_, i) => TOP + i * TRACK);
  const yLast = TOP + Math.max(0, tracks.length - 1) * TRACK;
  const plotH = mode === "blocks" ? 8 + BAR_H + 8 + 8 + 8 : yLast + BAND / 2 + 22;
  const height = plotH + AXIS;

  // ------------------------------------------------------------ layers
  // Built only when the window, size or data change, so hovering re-renders
  // nothing but the overlay.
  const plot = useMemo(() => {
    if (mode === "blocks") return blocksLayer();
    return flowLayer();
  }, [mode, streams, blocks, labels, blockInfo, view, plotW, gutter, tracks, now, segs]);

  function flowLayer() {
    const joinMs = Math.max(60_000, (2 * span) / plotW);
    const defs: ReactNode[] = [];
    const left = gutter;
    const right = gutter + plotW;

    // One stream: flat bands on their track, Sankey ribbons between touching
    // pieces, a faint ribbon across short pauses, and a fade out and back in
    // around time away.
    const drawStream = (st: Stream, si: number) => {
      const { pieces: ps, h, dy } = st;
      const half = h / 2;
      const shapes: ReactNode[] = [];
      const band = (x0: number, x1: number, y: number) => `M${f(x0)},${f(y - half)}H${f(x1)}V${f(y + half)}H${f(x0)}Z`;
      const ribbon = (ax: number, ay: number, bx: number, by: number) =>
        `M${f(ax)},${f(ay - half)}${sCurve(ax, ay - half, bx, by - half)}V${f(by + half)}${sCurve(bx, by + half, ax, ay + half)}Z`;
      const grad = (id: string, x0: number, x1: number, from: string, to: string, o0 = 1, o1 = 1) =>
        defs.push(
          <linearGradient key={id} id={id} gradientUnits="userSpaceOnUse" x1={x0} x2={x1} y1={0} y2={0}>
            <stop offset="0.1" style={{ stopColor: from, stopOpacity: o0 }} />
            <stop offset="0.9" style={{ stopColor: to, stopOpacity: o1 }} />
          </linearGradient>,
        );
      const fade = (k: string, x0: number, x1: number, y: number, color: string, out: boolean) => {
        if (x1 - x0 < 1) return;
        const id = `${uid}s${si}f${k}`;
        grad(id, x0, x1, color, color, out ? 1 : 0, out ? 0 : 1);
        shapes.push(<path key={`f${k}`} d={band(x0, x1, y)} style={{ fill: `url(#${id})` }} />);
      };
      const gapKind = (a: Piece, b: Piece) => (b.start - a.end <= joinMs ? "touch" : b.start - a.end < AWAY_MS ? "pause" : "away");

      ps.forEach((p, k) => {
        const prev = ps[k - 1];
        const next = ps[k + 1];
        const x0 = x(p.start);
        const x1 = x(p.end);
        const w = x1 - x0;
        const y = ys[p.track] + dy;
        const color = colors[p.track];
        const before = prev ? gapKind(prev, p) : "away";
        const after = next ? gapKind(p, next) : "away";
        const a = before === "touch" ? Math.min(CURVE, w / 2) : 0;
        const b = after === "touch" ? Math.min(CURVE, w / 2) : 0;
        shapes.push(<path key={k} d={band(x0 + a, Math.max(x0 + a + 0.5, x1 - b), y)} style={{ fill: color }} />);
        if (before === "away") fade(`i${k}`, x0 - Math.min(FADE, prev ? (x0 - x(prev.end)) / 2 : FADE), x0, y, color, false);
        if (!next) {
          const isLive = now !== undefined && now - p.end < 2 * MINUTE;
          if (!isLive) fade(`o${k}`, x1, x1 + FADE, y, color, true);
          else if (si === 0 && mode === "flow") shapes.push(<circle key="live" className="flow-live" cx={x1} cy={y} r={half * 0.55} />);
          return;
        }
        const nx0 = x(next.start);
        const ny = ys[next.track] + dy;
        const ncolor = colors[next.track];
        if (after === "away") {
          fade(`o${k}`, x1, x1 + Math.min(FADE, (nx0 - x1) / 2), y, color, true);
          return;
        }
        const ax = x1 - b;
        const bx = after === "touch" ? nx0 + Math.min(CURVE, (x(next.end) - nx0) / 2) : nx0;
        const id = `${uid}s${si}g${k}`;
        grad(id, ax, bx, color, ncolor);
        shapes.push(<path key={`r${k}`} className={after === "pause" ? "flow-pause" : undefined} d={ribbon(ax, y, bx, ny)} style={{ fill: `url(#${id})` }} />);
      });
      return <g key={st.label || "you"} className="flow-stream">{shapes}</g>;
    };
    const drawn = streams.map(drawStream);

    // Block labels on brackets over the stream, where they fit (merged only).
    const notes: ReactNode[] = [];
    if (mode === "flow") {
      for (let i = firstEndingAfter(blocks, view.start); i < blocks.length && blocks[i].start < view.end; i++) {
        const bl = blocks[i];
        const info = blockInfo.get(bl.id)!;
        const bx0 = Math.max(left, x(bl.start));
        const bx1 = Math.min(right, x(bl.end));
        const w = bx1 - bx0;
        if (w < 26) continue;
        const yb = (ys[info.track] ?? TOP) - BAND / 2 - 9;
        const label = labels.get(bl.id) ?? bl.label;
        const text = fitFirst([`${label} · ${fmtDuration(info.active)}`, label], w - 14, LABEL_FONT);
        notes.push(
          <g key={bl.id}>
            <path className="flow-bracket" style={{ stroke: colors[info.track] }}
              d={`M${bx0 + 1.5},${yb + 5}Q${bx0 + 1.5},${yb} ${bx0 + 6.5},${yb}H${bx1 - 6.5}Q${bx1 - 1.5},${yb} ${bx1 - 1.5},${yb + 5}`} />
            {text && (
              <text className="flow-label" x={(bx0 + bx1) / 2} y={yb + 4} textAnchor="middle">
                {text}
              </text>
            )}
          </g>,
        );
        // Zoomed in far enough, the pieces inside get their own names below the stream.
        for (let k = firstEndingAfter(pieces, bl.start); k < pieces.length && pieces[k].start < bl.end; k++) {
          const p = pieces[k];
          const px0 = Math.max(left, x(Math.max(p.start, bl.start)));
          const px1 = Math.min(right, x(Math.min(p.end, bl.end)));
          if (px1 - px0 < 70) continue;
          const name = topSubject(segs, p, trackOf);
          if (!name || name === label) continue;
          const sub = fitText(name, px1 - px0 - 12, SUB_FONT);
          if (sub) notes.push(<text key={`${bl.id}-${k}`} className="flow-sub" x={(px0 + px1) / 2} y={ys[p.track] + BAND / 2 + 13} textAnchor="middle">{sub}</text>);
        }
      }
    }

    return (
      <>
        <defs>{defs}</defs>
        {tracks.map((c, i) => (
          <line key={c.key} className="flow-track" x1={gutter} x2={gutter + plotW} y1={ys[i]} y2={ys[i]} />
        ))}
        <g clipPath={`url(#${uid}clip)`}>
          {drawn}
          {notes}
        </g>
      </>
    );
  }

  function blocksLayer() {
    const out: ReactNode[] = [];
    const left = gutter;
    const right = gutter + plotW;
    const y = 8;
    for (let i = firstEndingAfter(blocks, view.start); i < blocks.length && blocks[i].start < view.end; i++) {
      const bl = blocks[i];
      const info = blockInfo.get(bl.id)!;
      const bx0 = Math.max(left, x(bl.start));
      const bx1 = Math.min(right, x(bl.end));
      const w = bx1 - bx0;
      if (w < 0.5) continue;
      const color = colors[info.track];
      const inset = w > 6 ? 1 : 0;
      const label = labels.get(bl.id) ?? bl.label;
      const line1 = w > 34 ? fitText(label, w - 16, BAR_FONT) : null;
      const line2 = w > 34 ? fitFirst([`${fmtDuration(info.active)} · ${fmtTime(bl.start)}`, fmtDuration(info.active)], w - 16, SUB_FONT) : null;
      out.push(
        <g key={bl.id}>
          <rect x={bx0 + inset} y={y} width={Math.max(1, w - 2 * inset)} height={BAR_H} rx={Math.min(7, w / 2)}
            style={{ fill: `color-mix(in srgb, ${color} 22%, var(--surface))` }} />
          {w > 5 && <rect x={bx0 + inset} y={y} width={3} height={BAR_H} rx={1.5} style={{ fill: color }} />}
          {line1 && <text className="bar-label" x={bx0 + 10} y={y + 19}>{line1}</text>}
          {line2 && <text className="bar-sub" x={bx0 + 10} y={y + 35}>{line2}</text>}
        </g>,
      );
    }
    // Under the bars, what was actually on screen.
    const detail = runsIn(segs, view, x, (s) => colors[trackOf(s)]);
    const dy = y + BAR_H + 8;
    return (
      <g clipPath={`url(#${uid}clip)`}>
        {out}
        <rect x={gutter} y={dy} width={plotW} height={8} rx={4} fill="var(--idle)" />
        {detail.map((r, k) => (
          <rect key={k} x={r.x0} y={dy} width={Math.max(1, r.x1 - r.x0)} height={8} rx={r.x1 - r.x0 > 8 ? 2 : 0} style={{ fill: r.color }} />
        ))}
      </g>
    );
  }

  // ------------------------------------------------------------ hover
  const [hover, setHover] = useState<{ px: number; py: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const live = useRef({ view, range, set, tAt, plotW, span, zoom, pan });
  live.current = { view, range, set, tAt, plotW, span, zoom, pan };

  let tip: TipState | null = null;
  let overlay: ReactNode = null;
  if (hover && hover.px >= gutter) {
    const t = tAt(hover.px);
    const slack = (span / plotW) * 6;
    const hx = x(t);
    if (mode === "devices") {
      // The device stream nearest the pointer.
      let best: { st: Stream; y: number } | null = null;
      for (const st of streams) {
        const p = nearestAt(st.pieces, t, slack);
        if (!p) continue;
        const y = ys[p.track] + st.dy;
        if (!best || Math.abs(hover.py - y) < Math.abs(hover.py - best.y)) best = { st, y };
      }
      const s = best ? nearestAt(best.st.segs, t, slack) : null;
      tip = {
        x: hx,
        y: Math.min(plotH, (best?.y ?? TOP) + DEVICE_BAND + 10),
        content: s ? <SegTip s={s} deviceLabel={deviceLabel} /> : <Nothing t={t} />,
      };
      overlay = (
        <>
          <line className="hover-line" x1={hx} x2={hx} y1={0} y2={plotH} />
          {best && s && <circle className="flow-dot" cx={hx} cy={best.y} r={3.5} style={{ stroke: colors[trackOf(s)] }} />}
        </>
      );
    } else {
      const bl = nearestAt(blocks, t, slack);
      const s = nearestAt(segs, t, slack);
      const p = mode === "flow" ? nearestAt(pieces, t, slack) : null;
      const hy = p ? ys[p.track] : null;
      tip = {
        x: hx,
        y: mode === "flow" ? Math.min(plotH, (hy ?? TOP) + BAND / 2 + 12) : 8 + BAR_H + 22,
        content: bl ? <BlockTip block={bl} label={labels.get(bl.id) ?? bl.label} at={s} t={t} /> : <Nothing t={t} />,
      };
      overlay = (
        <>
          <line className="hover-line" x1={hx} x2={hx} y1={0} y2={plotH} />
          {mode === "flow" && p && hy !== null && <circle className="flow-dot" cx={hx} cy={hy} r={4} style={{ stroke: colors[p.track] }} />}
          {mode === "blocks" && bl && (
            <rect className="bar-hover" x={Math.max(gutter, x(bl.start)) + 0.5} y={8.5}
              width={Math.max(1, Math.min(gutter + plotW, x(bl.end)) - Math.max(gutter, x(bl.start)) - 1)} height={BAR_H - 1} rx={6.5} />
          )}
        </>
      );
    }
  }

  // ------------------------------------------------------------ pointer
  const drag = useRef<{ id: number; x: number; view: View; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ d: number; view: View; t: number } | null>(null);
  const localX = (clientX: number) => clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, e.clientX);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.max(10, Math.abs(a - b)), view, t: tAt(localX((a + b) / 2)) };
      drag.current = null;
      setHover(null);
    } else {
      drag.current = { id: e.pointerId, x: e.clientX, view, moved: false };
    }
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, e.clientX);
    const pz = pinch.current;
    if (pz && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const next = ((pz.view.end - pz.view.start) * pz.d) / Math.max(10, Math.abs(a - b));
      const start = pz.t - ((localX((a + b) / 2) - gutter) / plotW) * next;
      set(clamp({ start, end: start + next }));
      return;
    }
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 4) d.moved = true;
      if (d.moved) {
        set(pan(d.view, (-dx / plotW) * (d.view.end - d.view.start)));
        setHover(null);
        return;
      }
    }
    if (e.pointerType === "mouse") {
      const box = e.currentTarget.getBoundingClientRect();
      setHover({ px: e.clientX - box.left, py: e.clientY - box.top });
    }
  };

  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      drag.current = null;
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || d.id !== e.pointerId) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    if (px < gutter) return;
    const t = tAt(px);
    // A tap shows what's there; a second tap on the same block (or a click) zooms to it.
    const bl = nearestAt(blocks, t, (span / plotW) * 6);
    if (e.pointerType !== "mouse") {
      const shown = hover && nearestAt(blocks, tAt(hover.px), (span / plotW) * 6);
      if (!bl || shown !== bl) return setHover({ px, py: e.clientY - box.top });
      setHover(null);
    }
    if (bl) {
      const pad = Math.max((bl.end - bl.start) * 0.12, MINUTE);
      const target = clamp({ start: bl.start - pad, end: bl.end + pad });
      animateTo(sameView(target, view, 30_000) ? zoom(view, t, 0.4) : target);
    } else animateTo(zoom(view, t, 0.5));
  };

  const onCancel = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    pinch.current = null;
    drag.current = null;
  };

  // Wheel: native and non-passive, so the page doesn't scroll while zooming.
  // Zoomed out to the day or wider, scrolling down still scrolls the page.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { range, set, tAt, plotW, span, zoom, pan } = live.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
        set(pan(live.current.view, (dx / plotW) * span));
        return;
      }
      const factor = Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015));
      if (factor > 1 && span >= range.end - range.start - 1000) return;
      e.preventDefault();
      set(zoom(live.current.view, tAt(e.clientX - el.getBoundingClientRect().left), factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const mid = view.start + span / 2;
    const act: Record<string, () => void> = {
      ArrowLeft: () => animateTo(pan(view, -span * 0.25)),
      ArrowRight: () => animateTo(pan(view, span * 0.25)),
      ArrowUp: () => animateTo(zoom(view, mid, 0.5)),
      ArrowDown: () => animateTo(zoom(view, mid, 2)),
      "+": () => animateTo(zoom(view, mid, 0.5)),
      "=": () => animateTo(zoom(view, mid, 0.5)),
      "-": () => animateTo(zoom(view, mid, 2)),
      "0": () => animateTo(range),
      Home: () => animateTo(range),
    };
    const fn = act[e.key];
    if (!fn || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    fn();
  };

  const fitted = sameView(view, clamp(range));
  const widest = span >= Math.min(MAX_SPAN, bounds.end - bounds.start) - 1000;
  const zoomed = span <= MIN_SPAN + 1000;
  // Where one day turns into the next, inside the window.
  const midnights = daysIn(view, dayOffset).filter((d) => d > view.start);
  const mid = view.start + span / 2;

  return (
    <div className="flow" onKeyDown={onKey}>
      <div className="card-head flow-head">
        <h2>{title}</h2>
        <span className="flow-window muted small num">
          {fitted ? "" : midnights.length ? `${fmtShortDay(view.start)} ${fmtTime(view.start)} – ${fmtShortDay(view.end)} ${fmtTime(view.end)}` : `${fmtTime(view.start)} – ${fmtTime(view.end)}`}
        </span>
        <span className="spacer" />
        <div className="seg-control" role="group" aria-label="Timeline view">
          <button aria-pressed={mode === "flow"} onClick={() => setMode("flow")}>Flow</button>
          <button aria-pressed={mode === "blocks"} onClick={() => setMode("blocks")}>Blocks</button>
          <button aria-pressed={mode === "devices"} onClick={() => setMode("devices")}>Devices</button>
        </div>
        <div className="flow-zoom" role="group" aria-label="Zoom">
          <button className="icon-btn" onClick={() => animateTo(zoom(view, mid, 2))} disabled={widest} aria-label="Zoom out">−</button>
          <button className="icon-btn" onClick={() => animateTo(zoom(view, mid, 0.5))} disabled={zoomed} aria-label="Zoom in">+</button>
          <button className="icon-btn" onClick={() => animateTo(range)} disabled={fitted}>Fit day</button>
        </div>
      </div>
      <div className="chart" ref={ref} tabIndex={0} aria-label="Timeline. Arrow keys pan and zoom across days, 0 fits the day.">
        <svg ref={svgRef} className="flow-plot" width={width} height={height} role="img"
          aria-label={`Timeline of ${segs.length} pieces of activity`}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}>
          <defs>
            <clipPath id={`${uid}clip`}>
              <rect x={gutter} y={-20} width={plotW} height={height + 20} />
            </clipPath>
          </defs>
          {ticks.list.map((t) => (
            <line key={t} className="gridline" x1={x(t)} x2={x(t)} y1={0} y2={plotH} />
          ))}
          {mode !== "blocks" && (
            <g className="flow-names">
              {tracks.map((c, i) => (
                <g key={c.key}>
                  <circle cx={4} cy={ys[i]} r={3.5} style={{ fill: colors[i] }} />
                  <text x={13} y={ys[i] + 4}>{fitText(trackName(c), gutter - 18, NAME_FONT) ?? ""}</text>
                </g>
              ))}
            </g>
          )}
          {plot}
          {midnights.map((d) => (
            <line key={d} className="day-line" x1={x(d)} x2={x(d)} y1={0} y2={plotH} />
          ))}
          {now !== undefined && now > view.start && now < view.end && (
            <line className="now-line" x1={x(now)} x2={x(now)} y1={0} y2={plotH} />
          )}
          {overlay}
          {ticks.list
            .filter((t) => midnights.every((d) => Math.abs(x(t) - x(d)) > 44))
            .map((t) => (
              <text key={t} x={x(t)} y={height - 7} textAnchor="middle">
                {ticks.fmt(t)}
              </text>
            ))}
          {midnights.map((d) => (
            <text key={d} className="day-label" x={x(d)} y={height - 7} textAnchor="middle">
              {fmtShortDay(d)}
            </text>
          ))}
        </svg>
        <Minimap segs={segs} trackOf={trackOf} tracks={Math.max(1, tracks.length)} colors={colors} range={range}
          view={view} set={set} clamp={clamp} gutter={gutter} plotW={plotW} width={width} now={now} />
        <Tooltip tip={tip} width={width} />
      </div>
      {mode === "blocks" && <Legend tracks={tracks} />}
      {mode === "devices" && streams.length > 1 && (
        <div className="legend small muted">
          {streams.map((st, i) => (
            <span key={st.label}>{st.label}: {i === 0 ? "upper stream" : i === streams.length - 1 ? "lower stream" : "middle stream"}</span>
          ))}
        </div>
      )}
    </div>
  );
}

const BAR_H = 44;

interface Stream {
  label: string;
  segs: CSeg[];
  pieces: Piece[];
  h: number; // thickness
  dy: number; // offset from the track's line
}

const f = (n: number) => n.toFixed(1);

/** Where a top-level category sits, higher is better: its score when it has
 *  one, else a guess from its name (work and study high, talking a little
 *  above the middle, media and games low). Uncategorized time is the middle. */
export function goodness(c: Category, uncategorized = false): number {
  if (uncategorized) return -0.5;
  if (c.score !== null && c.score !== 0) return c.score;
  const n = c.leaf.toLowerCase();
  if (/work|school|study|class|code|programming|writing|research|learn/.test(n)) return 10;
  if (/media|video|game|social|entertain|stream|tv|music|fun|leisure/.test(n)) return -10;
  if (/comm|chat|email|mail|message|im/.test(n)) return 3;
  return c.score === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ viewport

/** The visible window (`fit` until zoomed or moved), kept inside `bounds`, and
 *  smooth moves to a new one. A new `jump` goes back to `fit`. */
function useViewport(bounds: Range, fit: Range, jump: number) {
  const [stored, setStored] = useState<View | null>(null);
  const [seenJump, setSeenJump] = useState(jump);
  if (seenJump !== jump) {
    // Reset during render, so no effect ever sees the old day's window.
    setSeenJump(jump);
    setStored(null);
  }
  const view = useMemo(() => clampView(stored ?? fit, bounds, MIN_SPAN, MAX_SPAN), [stored, fit, bounds]);
  const current = useRef(view);
  current.current = view;
  const limits = useRef({ bounds, fit });
  limits.current = { bounds, fit };
  const anim = useRef(0);

  useEffect(() => cancelAnimationFrame(anim.current), [jump]);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const clamp = (v: View) => clampView(v, limits.current.bounds, MIN_SPAN, MAX_SPAN);
  // Back on the day's own stretch, follow it again (it grows while live).
  const settle = (v: View) => (sameView(clamp(v), clamp(limits.current.fit)) ? null : v);
  const set = (v: View) => {
    cancelAnimationFrame(anim.current);
    setStored(settle(v));
  };
  const animateTo = (target: View) => {
    cancelAnimationFrame(anim.current);
    const from = current.current;
    const to = clamp(target);
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 280);
      const e = 1 - (1 - k) ** 3;
      const v = { start: from.start + (to.start - from.start) * e, end: from.end + (to.end - from.end) * e };
      setStored(k === 1 ? settle(v) : v);
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  return { view, set, animateTo };
}

// ------------------------------------------------------------------ minimap

interface MiniProps {
  segs: CSeg[];
  trackOf: (s: CSeg) => number;
  tracks: number;
  colors: string[];
  range: Range;
  view: View;
  set: (v: View) => void;
  clamp: (v: View) => View;
  gutter: number;
  plotW: number;
  width: number;
  now?: number;
}

/** The day as a small line, with the window as a brush: drag it to move (on
 *  past the ends into the next day), drag its edges to resize, press
 *  elsewhere to jump there. */
function Minimap({ segs, trackOf, tracks, colors, range, view, set, clamp, gutter, plotW, width, now }: MiniProps) {
  const span = range.end - range.start;
  const x = (t: number) => gutter + ((t - range.start) / span) * plotW;
  const yOf = (track: number) => 5 + (tracks > 1 ? (track / (tracks - 1)) * (MINI - 12) : (MINI - 12) / 2);
  const line = useMemo(() => {
    const pieces = linePieces(segs, trackOf, tracks, range, plotW, 2);
    return pieces.map((p, k) => {
      const prev = pieces[k - 1];
      const x0 = x(p.start);
      const y = yOf(p.track);
      const from = prev && p.start - prev.end < 2 * MINUTE ? `M${x(prev.end).toFixed(1)},${yOf(prev.track)}${sCurve(x(prev.end), yOf(prev.track), x0 + 1.5, y)}` : `M${x0.toFixed(1)},${y}`;
      return <path key={k} d={`${from}H${Math.max(x0 + 1, x(p.end)).toFixed(1)}`} style={{ stroke: colors[p.track] }} />;
    });
  }, [segs, trackOf, tracks, range.start, range.end, plotW, gutter, colors.join()]);

  // The part of the window over the day (a window in the next day sits at the edge).
  const right = gutter + plotW;
  const bx1 = Math.max(gutter + 2, Math.min(right, x(view.end)));
  const bx0 = Math.min(bx1 - 2, Math.max(gutter, x(view.start)));
  const drag = useRef<{ kind: "move" | "l" | "r"; x: number; view: View } | null>(null);

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const edge = Math.min(10, (bx1 - bx0) / 3);
    let start = view;
    let kind: "move" | "l" | "r" = "move";
    if (Math.abs(px - bx0) <= edge) kind = "l";
    else if (Math.abs(px - bx1) <= edge) kind = "r";
    else if (px < bx0 || px > bx1) {
      // Jump: centre the window where pressed.
      const t = range.start + ((px - gutter) / plotW) * span;
      const w = view.end - view.start;
      start = clamp({ start: t - w / 2, end: t + w / 2 });
      set(start);
    }
    drag.current = { kind, x: e.clientX, view: start };
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dt = ((e.clientX - d.x) / plotW) * span;
    const v = d.view;
    if (d.kind === "move") set(clamp({ start: v.start + dt, end: v.end + dt }));
    else if (d.kind === "l") set(clamp({ start: Math.min(v.start + dt, v.end - MIN_SPAN), end: v.end }));
    else set(clamp({ start: v.start, end: Math.max(v.end + dt, v.start + MIN_SPAN) }));
  };
  const onUp = () => (drag.current = null);

  return (
    <svg className="flow-mini" width={width} height={MINI} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerCancel={onUp} aria-hidden="true">
      <rect x={gutter} y={0.5} width={plotW} height={MINI - 1} rx={6} className="mini-bg" />
      <g className="mini-line">{line}</g>
      {now !== undefined && now > range.start && now < range.end && <line className="now-line" x1={x(now)} x2={x(now)} y1={2} y2={MINI - 2} />}
      <rect className="mini-shade" x={gutter} y={0} width={Math.max(0, bx0 - gutter)} height={MINI} />
      <rect className="mini-shade" x={bx1} y={0} width={Math.max(0, gutter + plotW - bx1)} height={MINI} />
      <rect className="mini-brush" x={bx0} y={0.5} width={Math.max(2, bx1 - bx0)} height={MINI - 1} rx={6} />
      <line className="mini-grip" x1={bx0 + 3.5} x2={bx0 + 3.5} y1={MINI / 2 - 5} y2={MINI / 2 + 5} />
      <line className="mini-grip" x1={bx1 - 3.5} x2={bx1 - 3.5} y1={MINI / 2 - 5} y2={MINI / 2 + 5} />
      <text className="mini-label" x={0} y={MINI / 2 + 4}>{fmtShortDay(range.start).split(/[ ,]/)[0]}</text>
    </svg>
  );
}

// ------------------------------------------------------------------ pieces

function Legend({ tracks }: { tracks: Category[] }) {
  if (!tracks.length) return null;
  return (
    <div className="legend">
      {tracks.map((c) => (
        <span key={c.key}>
          <span className="swatch" style={{ background: slotColor(c.slot) }} />
          {c.key}
        </span>
      ))}
    </div>
  );
}

function Nothing({ t }: { t: number }) {
  return (
    <>
      <div className="t-title">{fmtTime(t)}</div>
      <div className="t-row">Nothing in use</div>
    </>
  );
}

function BlockTip({ block, label, at, t }: { block: Block; label: string; at: CSeg | null; t: number }) {
  const { cats } = useApp();
  const active = block.segs.reduce((a, s) => a + (s.end - s.start), 0) / 1000;
  const colorOf = (category: string) => slotColor(cats.byKey.get(category.split(" › ").join(" > "))?.slot ?? null);
  // Slivers (a window caught for a second on the way somewhere) aren't worth a row.
  const items = block.items.filter((i) => i.seconds >= 30);
  return (
    <>
      <div className="t-title">{label}</div>
      <div className="t-row">
        <span className="grow">{fmtTime(block.start)} – {fmtTime(block.end)}</span>
        <span className="num">{fmtDuration(active)}</span>
      </div>
      <div style={{ marginTop: 6 }}>
        {items.slice(0, 4).map((i) => (
          <div key={i.subject} className="t-row small">
            <span className="swatch" style={{ background: colorOf(i.category) }} />
            <span className="grow">{displayName(i)}</span>
            <span className="num">{fmtDuration(i.seconds)}</span>
          </div>
        ))}
        {items.length > 4 && <div className="t-row small muted">and {items.length - 4} more</div>}
      </div>
      {at && (
        <div className="t-row small muted" style={{ marginTop: 6 }}>
          {fmtTime(t)}: {displayName({ ...at, subject: subject(at) })}
          {at.title && at.title !== at.app ? ` — ${at.title}` : ""}
        </div>
      )}
    </>
  );
}

/** The subject with the most time inside a piece (on the piece's track). */
function topSubject(segs: CSeg[], p: Piece, trackOf: (s: CSeg) => number): string | null {
  const totals = new Map<string, number>();
  for (let i = firstEndingAfter(segs, p.start); i < segs.length && segs[i].start < p.end; i++) {
    const s = segs[i];
    if (trackOf(s) !== p.track) continue;
    const k = displayName({ ...s, subject: subject(s) });
    totals.set(k, (totals.get(k) ?? 0) + Math.min(s.end, p.end) - Math.max(s.start, p.start));
  }
  let best: string | null = null;
  let most = 0;
  for (const [k, ms] of totals) if (ms > most) [best, most] = [k, ms];
  return best;
}

/** Runs of one color inside the window, merged where neighbours sit closer
 *  than half a pixel. */
function runsIn(segs: CSeg[], v: View, x: (t: number) => number, colorOf: (s: CSeg) => string) {
  const out: { x0: number; x1: number; color: string }[] = [];
  for (let i = firstEndingAfter(segs, v.start); i < segs.length && segs[i].start < v.end; i++) {
    const s = segs[i];
    const x0 = x(Math.max(s.start, v.start));
    const x1 = x(Math.min(s.end, v.end));
    if (x1 <= x0) continue;
    const color = colorOf(s);
    const prev = out[out.length - 1];
    if (prev && prev.color === color && x0 - prev.x1 < 0.5) prev.x1 = x1;
    else out.push({ x0, x1, color });
  }
  return out;
}

// ------------------------------------------------------------------ text

let measure: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (measure === undefined) measure = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * 6.6;
  measure.font = font;
  return measure.measureText(text).width;
}

/** The first option that fits whole, else the last one cut to fit. */
function fitFirst(options: string[], maxW: number, font: string): string | null {
  for (const o of options) if (textWidth(o, font) <= maxW) return o;
  return fitText(options[options.length - 1], maxW, font);
}

/** The text, cut with an ellipsis to fit `maxW`; null when not even a few
 *  letters fit. */
function fitText(text: string, maxW: number, font: string): string | null {
  if (maxW <= 0) return null;
  if (textWidth(text, font) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(text.slice(0, mid).trimEnd() + "…", font) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo >= 4 ? text.slice(0, lo).trimEnd() + "…" : null;
}

