// Small figures: the productive / neutral / distracting split, category rows
// with bars, and stat tiles. Every value is written out as text beside its
// color, so nothing is told by color alone.

import { Fragment, useState } from "react";
import type { CSeg } from "../lib/aggregate";
import type { Category, CategorySet, Rating } from "../lib/categories";
import { RATING_COLOR, slotColor } from "../lib/palette";
import { fmtDuration } from "../lib/time";

export function ratingTotals(segs: CSeg[]): Record<Rating, number> {
  const out: Record<Rating, number> = { productive: 0, neutral: 0, distracting: 0 };
  for (const s of segs) out[s.home ? "neutral" : s.cat.rating] += (s.end - s.start) / 1000;
  return out;
}

const RATING_LABEL: Record<Rating, string> = { productive: "Productive", neutral: "Neutral", distracting: "Distracting" };

export function RatingSplit({ totals }: { totals: Record<Rating, number> }) {
  const all = totals.productive + totals.neutral + totals.distracting;
  const order: Rating[] = ["productive", "neutral", "distracting"];
  return (
    <div>
      <div className="split" role="img"
        aria-label={order.map((r) => `${RATING_LABEL[r]} ${fmtDuration(totals[r])}`).join(", ")}>
        {all > 0 &&
          order.map((r) =>
            totals[r] > 0 ? <div key={r} style={{ flex: totals[r], background: RATING_COLOR[r] }} /> : null,
          )}
      </div>
      <div className="legend">
        {order.map((r) => (
          <span key={r}>
            <span className="swatch" style={{ background: RATING_COLOR[r] }} />
            {RATING_LABEL[r]} <b className="num">{fmtDuration(totals[r])}</b>
            {all > 0 && <span className="muted num">{Math.round((totals[r] / all) * 100)}%</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Top-level categories by time, each expandable into its subcategories. */
export function CategoryBars({ segs, cats, limit = 8 }: { segs: CSeg[]; cats: CategorySet; limit?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const total = segs.reduce((a, s) => a + (s.end - s.start) / 1000, 0);
  const byRoot = new Map<string, number>();
  const byCat = new Map<string, number>();
  for (const s of segs) {
    const sec = (s.end - s.start) / 1000;
    const root = cats.root(s.cat).key;
    byRoot.set(root, (byRoot.get(root) ?? 0) + sec);
    byCat.set(s.cat.key, (byCat.get(s.cat.key) ?? 0) + sec);
  }
  const rows = [...byRoot].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!rows.length) return <div className="empty">Nothing yet.</div>;
  const max = rows[0][1];
  const childrenOf = (root: string) =>
    cats.list
      .filter((c) => c.depth === 1 && c.name[0] === root)
      .map((c) => [c, subtreeSeconds(c, cats, byCat)] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]);

  return (
    <div className="cat-rows">
      {rows.map(([key, sec]) => {
        const cat = cats.byKey.get(key)!;
        const kids = childrenOf(key);
        const own = byCat.get(key) ?? 0;
        return (
          <Fragment key={key}>
            <CatRow cat={cat} seconds={sec} max={max} total={total} expandable={kids.length > 0}
              open={open === key} onToggle={() => setOpen(open === key ? null : key)} />
            {open === key && (
              <>
                {kids.map(([c, s]) => (
                  <CatRow key={c.key} cat={c} seconds={s} max={max} total={total} child />
                ))}
                {own > 0 && kids.length > 0 && (
                  <CatRow cat={cat} label={`${cat.leaf} (other)`} seconds={own} max={max} total={total} child />
                )}
              </>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function subtreeSeconds(c: Category, cats: CategorySet, byCat: Map<string, number>): number {
  let sec = 0;
  for (const d of cats.list) if (d.key === c.key || d.key.startsWith(c.key + " > ")) sec += byCat.get(d.key) ?? 0;
  return sec;
}

function CatRow(props: {
  cat: Category;
  label?: string;
  seconds: number;
  max: number;
  total: number;
  child?: boolean;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const { cat, seconds, max, total, child, expandable, open, onToggle } = props;
  return (
    <div className={`cat-row${child ? " child" : ""}${expandable ? " clickable" : ""}`} onClick={expandable ? onToggle : undefined}
      role={expandable ? "button" : undefined} aria-expanded={expandable ? open : undefined} tabIndex={expandable ? 0 : undefined}
      onKeyDown={(e) => expandable && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle?.())}>
      <div className="name">
        <span className="swatch" style={{ background: slotColor(cat.slot) }} />
        <span>
          {props.label ?? (child ? cat.leaf : cat.key)}
          {expandable && <span className="muted"> {open ? "▾" : "▸"}</span>}
        </span>
      </div>
      <div className="num">
        {fmtDuration(seconds)} <span className="muted">{total > 0 ? `${Math.round((seconds / total) * 100)}%` : ""}</span>
      </div>
      <div className="bar">
        <div style={{ width: `${(seconds / max) * 100}%`, background: slotColor(cat.slot), opacity: child ? 0.75 : 1 }} />
      </div>
    </div>
  );
}

export function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}
