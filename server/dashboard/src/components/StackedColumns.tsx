// Columns per day (or hour), stacked by series. Columns are capped at 24px with
// air around them, a 2px surface gap between stacked parts, and a rounded top.

import { useState } from "react";
import { fmtDuration, fmtHours } from "../lib/time";
import { Tooltip, type TipState } from "./Tooltip";
import { useWidth } from "./useWidth";

export interface Part {
  key: string;
  label: string;
  color: string;
  seconds: number;
}

export interface Column {
  key: number;
  label: string;
  parts: Part[]; // bottom first
}

const AXIS_W = 40;
const AXIS_H = 22;

function niceMax(seconds: number): { max: number; step: number } {
  const hours = seconds / 3600;
  const steps = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12];
  const step = steps.find((s) => hours / s <= 4) ?? 24;
  return { max: Math.max(step, Math.ceil(hours / step) * step) * 3600, step: step * 3600 };
}

function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function StackedColumns({ columns, height = 220 }: { columns: Column[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const totals = columns.map((c) => c.parts.reduce((a, p) => a + p.seconds, 0));
  const { max, step } = niceMax(Math.max(1, ...totals));
  const plotW = Math.max(10, width - AXIS_W);
  const plotH = height - AXIS_H;
  const band = plotW / Math.max(1, columns.length);
  const colW = Math.min(24, band * 0.62);
  const y = (s: number) => plotH - (s / max) * plotH;
  const labelEvery = Math.ceil(46 / band);

  const gridlines: number[] = [];
  for (let s = 0; s <= max; s += step) gridlines.push(s);

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setTip(null)}>
      <svg width={width} height={height} role="img" aria-label="Time per column, stacked">
        {gridlines.map((s) => (
          <g key={s}>
            <line className={s === 0 ? "baseline" : "gridline"} x1={AXIS_W} x2={width} y1={y(s)} y2={y(s)} />
            <text x={AXIS_W - 6} y={y(s) + 4} textAnchor="end">
              {fmtHours(s)}
            </text>
          </g>
        ))}
        {columns.map((c, ci) => {
          const cx = AXIS_W + band * ci + (band - colW) / 2;
          let acc = 0;
          const visible = c.parts.filter((p) => p.seconds > 0);
          return (
            <g key={c.key}>
              {visible.map((p, pi) => {
                const y0 = y(acc);
                acc += p.seconds;
                const y1 = y(acc);
                const h = Math.max(0, y0 - y1 - (pi > 0 ? 2 : 0)); // 2px surface gap below each upper part
                const isTop = pi === visible.length - 1;
                const enter = () =>
                  setTip({
                    x: cx + colW,
                    y: Math.max(0, y1 - 10),
                    content: (
                      <>
                        <div className="t-title">{c.label}</div>
                        <div className="t-row">
                          <span className="swatch" style={{ background: p.color }} />
                          <span className="grow">{p.label}</span>
                          <span className="num">{fmtDuration(p.seconds)}</span>
                        </div>
                        <div className="t-row muted">
                          <span className="grow">Total</span>
                          <span className="num">{fmtDuration(totals[ci])}</span>
                        </div>
                      </>
                    ),
                  });
                return isTop ? (
                  <path key={p.key} d={topRounded(cx, y1, colW, h, 4)} fill={p.color} onPointerEnter={enter} />
                ) : (
                  <rect key={p.key} x={cx} y={y1} width={colW} height={h} fill={p.color} onPointerEnter={enter} />
                );
              })}
              {/* a hit area the full height of the band, for the column total */}
              {visible.length === 0 && (
                <rect x={AXIS_W + band * ci} y={0} width={band} height={plotH} fill="transparent"
                  onPointerEnter={() => setTip({ x: cx, y: plotH - 40, content: <div className="t-title">{c.label}: nothing</div> })} />
              )}
              {ci % labelEvery === 0 && (
                <text x={cx + colW / 2} y={height - 6} textAnchor="middle">
                  {c.label}
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
