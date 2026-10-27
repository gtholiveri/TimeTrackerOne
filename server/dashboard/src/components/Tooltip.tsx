import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

const W = 260;
const MARGIN = 8;

/** A tooltip for a `.chart` container; `x` and `y` are relative to it. It is
 *  drawn fixed-position on the body and kept inside the viewport, so it never
 *  changes the page's size (a tooltip hanging past the bottom of the page used
 *  to toggle the scrollbar on every hover and jolt the layout). */
export function Tooltip({ tip, width }: { tip: TipState | null; width: number }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!tip || !anchor.current) return setPos(null);
    const chart = anchor.current.parentElement!.getBoundingClientRect();
    const h = box.current?.offsetHeight ?? 0;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const right = chart.left + Math.min(tip.x + 14, Math.max(0, width - W));
    const left = Math.max(MARGIN, Math.min(right, vw - W - MARGIN));
    let top = chart.top + tip.y;
    if (top + h > vh - MARGIN) top = Math.max(MARGIN, chart.top + tip.y - h - 28); // flip above the pointer
    setPos({ left, top });
  }, [tip, width]);

  return (
    <>
      <span ref={anchor} className="tooltip-anchor" aria-hidden />
      {tip &&
        createPortal(
          <div ref={box} className="tooltip" role="status"
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: W, visibility: pos ? "visible" : "hidden" }}>
            {tip.content}
          </div>,
          document.body,
        )}
    </>
  );
}
