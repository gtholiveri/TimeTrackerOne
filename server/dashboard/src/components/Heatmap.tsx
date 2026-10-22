// Weekday by clock hour, shaded by average active minutes (one blue ramp,
// light to dark). A scale legend sits underneath; hover gives the number.

import { useState } from "react";
import { fmtDuration } from "../lib/time";
import { Tooltip, type TipState } from "./Tooltip";
import { useWidth } from "./useWidth";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STEPS = 7; // --seq-1 .. --seq-7; --seq-0 is "none"

const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

export function Heatmap({ minutes, note }: { minutes: number[][]; note?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const labelW = 34;
  const cell = Math.max(8, Math.min(30, (width - labelW) / 24));
  const gap = cell > 12 ? 2 : 1;
  const max = Math.max(1, ...minutes.flat());
  const shade = (m: number) => (m <= 0.5 ? 0 : Math.min(STEPS, 1 + Math.floor((m / max) * STEPS * 0.999)));
  const height = 7 * cell + 20;

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setTip(null)}>
      <svg width={width} height={height} role="img" aria-label="Average active minutes by weekday and hour">
        {DAYS.map((d, w) => (
          <g key={d}>
            <text x={0} y={w * cell + cell / 2 + 4}>
              {d}
            </text>
            {minutes[w].map((m, h) => (
              <rect key={h} x={labelW + h * cell} y={w * cell} width={cell - gap} height={cell - gap} rx={2}
                fill={`var(--seq-${shade(m)})`}
                onPointerEnter={() =>
                  setTip({
                    x: labelW + h * cell + cell,
                    y: w * cell + cell,
                    content: (
                      <>
                        <div className="t-title">
                          {d} {hourLabel(h)}–{hourLabel((h + 1) % 24)}
                        </div>
                        <div className="t-row">{m > 0.05 ? `${fmtDuration(m * 60)} active on average` : "Nothing"}</div>
                      </>
                    ),
                  })
                } />
            ))}
          </g>
        ))}
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <text key={h} x={labelW + h * cell} y={height - 4}>
            {hourLabel(h)}
          </text>
        ))}
      </svg>
      <div className="legend" aria-hidden>
        <span>0</span>
        {Array.from({ length: STEPS }, (_, i) => (
          <span key={i} className="swatch" style={{ background: `var(--seq-${i + 1})`, width: 18 }} />
        ))}
        <span>{fmtDuration(max * 60)} per hour</span>
        {note && <span className="muted">· {note}</span>}
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}
