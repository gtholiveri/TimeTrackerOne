import type { ReactNode } from "react";

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

/** A tooltip inside a `.chart` container, kept within its width. */
export function Tooltip({ tip, width }: { tip: TipState | null; width: number }) {
  if (!tip) return null;
  const w = 260;
  const left = Math.max(0, Math.min(tip.x + 14, width - w));
  return (
    <div className="tooltip" style={{ left, top: tip.y, width: w }} role="status">
      {tip.content}
    </div>
  );
}
