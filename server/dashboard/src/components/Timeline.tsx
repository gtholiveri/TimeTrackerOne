// A day (or a few) as horizontal lanes of colored segments. Hover a moment to
// see what was on screen; the segment under the pointer is found by binary
// search, so thousands of segments stay cheap.

import { useMemo, useState, type PointerEvent } from "react";
import type { CSeg } from "../lib/aggregate";
import { findAt, type Span } from "../lib/intervals";
import { slotColor } from "../lib/palette";
import { DAY, HOUR, MINUTE, fmtDuration, fmtHour, fmtShortDay, fmtTime, type Range } from "../lib/time";
import { Tooltip, type TipState } from "./Tooltip";
import { useWidth } from "./useWidth";

export interface TimelineLane {
  label: string;
  segs: CSeg[];
}

interface Props {
  lanes: TimelineLane[];
  range: Range;
  now?: number;
  laneHeight?: number;
  showLabels?: boolean;
  showAxis?: boolean;
  colorOf?: (s: CSeg) => string;
  deviceLabel?: (host: string) => string;
}

const LANE_GAP = 10;

export const categoryColor = (s: CSeg) => slotColor(s.cat.slot);

/** The part of a day worth drawing: from the first activity to now (or the
 *  last activity), in whole hours, at least four of them. */
export function visibleRange(day: Range, segs: Span[], now: number | null): Range {
  const first = segs.length ? Math.min(...segs.map((s) => s.start)) : day.start + 3 * HOUR;
  const last = now ?? (segs.length ? Math.max(...segs.map((s) => s.end)) : day.start + 18 * HOUR);
  const floorHour = (t: number) => {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  };
  let start = Math.max(day.start, floorHour(first));
  let end = Math.min(day.end, floorHour(last + 15 * MINUTE) + HOUR);
  if (end - start < 4 * HOUR) start = Math.max(day.start, end - 4 * HOUR);
  if (end - start < 4 * HOUR) end = Math.min(day.end, start + 4 * HOUR);
  return { start, end };
}

export function Timeline(props: Props) {
  const { lanes, range, now, laneHeight = 28, showLabels = true, showAxis = true, colorOf = categoryColor, deviceLabel } = props;
  const AXIS = showAxis ? 22 : 2;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ t: number; lane: number } | null>(null);
  const labelW = showLabels ? Math.min(84, Math.max(56, width * 0.12)) : 0;
  const plotW = Math.max(10, width - labelW);
  const span = range.end - range.start;
  const x = (t: number) => labelW + ((t - range.start) / span) * plotW;
  const height = lanes.length * (laneHeight + LANE_GAP) - LANE_GAP + AXIS;

  // Runs of one color, merged where neighbours sit closer than half a pixel.
  const runs = useMemo(
    () =>
      lanes.map((lane) => {
        const out: { x0: number; x1: number; color: string }[] = [];
        for (const s of lane.segs) {
          const x0 = x(Math.max(s.start, range.start));
          const x1 = x(Math.min(s.end, range.end));
          if (x1 <= x0) continue;
          const color = colorOf(s);
          const prev = out[out.length - 1];
          if (prev && prev.color === color && x0 - prev.x1 < 0.5) prev.x1 = x1;
          else out.push({ x0, x1, color });
        }
        return out;
      }),
    [lanes, range.start, range.end, plotW, labelW, colorOf],
  );

  const ticks = useMemo(() => {
    const pxPerHour = plotW / (span / HOUR);
    if (span > 2 * DAY) {
      const out: number[] = [];
      const d = new Date(range.start);
      d.setHours(0, 0, 0, 0);
      for (let t = d.getTime(); t <= range.end; t += DAY) if (t >= range.start) out.push(t);
      return { list: out, fmt: fmtShortDay };
    }
    const step = [1, 2, 3, 4, 6, 12].find((h) => h * pxPerHour >= 54) ?? 24;
    const d = new Date(range.start);
    d.setMinutes(0, 0, 0);
    const out: number[] = [];
    for (let t = d.getTime(); t <= range.end; t += HOUR) {
      if (t >= range.start && new Date(t).getHours() % step === 0) out.push(t);
    }
    return { list: out, fmt: fmtHour };
  }, [plotW, span, range.start, range.end]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    if (px < labelW || px > width) return setHover(null);
    const lane = Math.floor(py / (laneHeight + LANE_GAP));
    if (lane < 0 || lane >= lanes.length) return setHover(null);
    setHover({ t: range.start + ((px - labelW) / plotW) * span, lane });
  };

  let tip: TipState | null = null;
  if (hover) {
    const lane = lanes[hover.lane];
    const i = findAt(lane.segs, hover.t);
    const s = i >= 0 ? lane.segs[i] : null;
    tip = {
      x: x(hover.t),
      y: (hover.lane + 1) * (laneHeight + LANE_GAP) - 4,
      content: s ? (
        <SegTip s={s} deviceLabel={deviceLabel} />
      ) : (
        <>
          <div className="t-title">{fmtTime(hover.t)}</div>
          <div className="t-row">Nothing in use</div>
        </>
      ),
    };
  }

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img"
        aria-label={`Timeline, ${lanes.map((l) => l.label).join(", ")}`}>
        {ticks.list.map((t) => (
          <line key={t} className="gridline" x1={x(t)} x2={x(t)} y1={0} y2={height - AXIS + 4} />
        ))}
        {lanes.map((lane, li) => {
          const y = li * (laneHeight + LANE_GAP);
          return (
            <g key={lane.label + li}>
              {showLabels && (
                <text className="lane-label" x={0} y={y + laneHeight / 2 + 4}>
                  {lane.label}
                </text>
              )}
              <rect x={labelW} y={y} width={plotW} height={laneHeight} rx={4} fill="var(--idle)" />
              {runs[li].map((r, k) => {
                const w = r.x1 - r.x0;
                const inset = w > 4 ? 1 : 0; // the 2px surface gap between touching runs
                return (
                  <rect key={k} x={r.x0 + inset} y={y} width={Math.max(1, w - 2 * inset)} height={laneHeight}
                    rx={w > 8 ? 3 : 0} fill={r.color} />
                );
              })}
            </g>
          );
        })}
        {now !== undefined && now > range.start && now < range.end && (
          <line className="now-line" x1={x(now)} x2={x(now)} y1={-3} y2={height - AXIS + 3} />
        )}
        {hover && <line className="hover-line" x1={x(hover.t)} x2={x(hover.t)} y1={0} y2={height - AXIS} />}
        {showAxis &&
          ticks.list.map((t) => (
            <text key={t} x={x(t)} y={height - 6} textAnchor="middle">
              {ticks.fmt(t)}
            </text>
          ))}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

const GUESSED: Record<string, string> = {
  inferred: "guessed from the automations",
  session: "from the automations only",
  provisional: "still going",
};

export function SegTip({ s, deviceLabel }: { s: CSeg; deviceLabel?: (host: string) => string }) {
  return (
    <>
      <div className="t-title">{s.domain ?? s.app}</div>
      {s.title && s.title !== s.app && <div className="t-row small">{s.title}</div>}
      <div className="t-row" style={{ marginTop: 6 }}>
        <span className="swatch" style={{ background: categoryColor(s) }} />
        <span className="grow">{s.cat.name.join(" › ")}</span>
      </div>
      <div className="t-row">
        <span className="grow">
          {fmtTime(s.start)} – {fmtTime(s.end)}
        </span>
        <span className="num">{fmtDuration((s.end - s.start) / 1000)}</span>
      </div>
      <div className="t-row small muted">
        {deviceLabel ? deviceLabel(s.host) : s.host}
        {s.confidence && GUESSED[s.confidence] ? ` · ${GUESSED[s.confidence]}` : ""}
      </div>
    </>
  );
}
