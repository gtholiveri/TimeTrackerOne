// The analytical view: one filter row above everything, then stat tiles,
// time per day (or hour) stacked, the weekday-by-hour heatmap, a top table you
// can group any way, the flow (where time went, what led to what), day strips,
// and the activity log.

import { useMemo, useState } from "react";
import { coalesce, perDay, perHour, ranked, subject, sumBy, weekHourGrid, type CSeg } from "../lib/aggregate";
import type { Category, Rating } from "../lib/categories";
import { PALETTE_LIGHT, RATING_COLOR, slotColor } from "../lib/palette";
import { useActivity, useApp, useDerived, useNow } from "../lib/store";
import { DAY, addDays, dayStart, fmtDuration, fmtHour, fmtShortDay, fmtTime, type Range } from "../lib/time";
import { CategoryBars, RatingSplit, ratingTotals, Tile } from "../components/Figures";
import { Heatmap } from "../components/Heatmap";
import { Sankey } from "../components/Sankey";
import { StackedColumns, type Column, type Part } from "../components/StackedColumns";
import { Timeline } from "../components/Timeline";
import { usePref } from "../components/usePref";
import { useWidth } from "../components/useWidth";
import { transitionFlow, whereFlow } from "../lib/flows";

type Preset = "today" | "yesterday" | "7d" | "30d" | "custom";
type StackBy = "category" | "rating" | "device";
type GroupBy = "category" | "subject" | "title" | "device";

const PRESETS: [Preset, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["custom", "Custom"],
];

const toDateInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function Explore() {
  const { cats, attention, dayOffset, devices } = useApp();
  const now = useNow(60_000);
  const today = dayStart(now, dayOffset);
  const [preset, setPreset] = usePref<Preset>("explore.preset", "7d");
  const [from, setFrom] = useState(() => toDateInput(addDays(today, -6, dayOffset)));
  const [to, setTo] = useState(() => toDateInput(today));
  const [view, setView] = usePref<"attention" | "devices">("explore.view", "attention");
  const [host, setHost] = useState("");
  const [catKey, setCatKey] = useState("");
  const [rating, setRating] = useState<Rating | "">("");
  const [search, setSearch] = useState("");
  const [stackBy, setStackBy] = usePref<StackBy>("explore.stack", "category");
  const [groupBy, setGroupBy] = usePref<GroupBy>("explore.group", "subject");

  const range: Range = useMemo(() => {
    const day = (n: number) => addDays(today, n, dayOffset);
    switch (preset) {
      case "today": return { start: today, end: day(1) };
      case "yesterday": return { start: day(-1), end: today };
      case "7d": return { start: day(-6), end: day(1) };
      case "30d": return { start: day(-29), end: day(1) };
      case "custom": {
        const a = dayStart(new Date(`${from}T12:00`).getTime(), dayOffset);
        const b = addDays(dayStart(new Date(`${to}T12:00`).getTime(), dayOffset), 1, dayOffset);
        return b > a ? { start: a, end: b } : { start: a, end: addDays(a, 1, dayOffset) };
      }
    }
  }, [preset, from, to, today, dayOffset]);

  const act = useActivity(range, 120_000);
  const derived = useDerived(act.lanes, cats, attention);
  const label = (h: string) => devices.find((d) => d.host === h)?.label ?? h;

  const segs: CSeg[] = useMemo(() => {
    if (!derived) return [];
    const base = view === "attention" ? derived.merged : derived.lanes.flatMap((l) => l.segs);
    const q = search.trim().toLowerCase();
    return base.filter(
      (s) =>
        (!host || s.host === host) &&
        (!catKey || s.cat.key === catKey || s.cat.key.startsWith(catKey + " > ")) &&
        (!rating || (s.home ? "neutral" : s.cat.rating) === rating) &&
        (!q || [s.app, s.title, s.url ?? "", s.domain ?? ""].some((f) => f.toLowerCase().includes(q))),
    );
  }, [derived, view, host, catKey, rating, search]);

  const total = segs.reduce((a, s) => a + (s.end - s.start) / 1000, 0);
  // Average over the days that have any data, so the first week isn't diluted.
  const days = useMemo(() => {
    const all = derived?.lanes.flatMap((l) => l.segs) ?? [];
    return Math.max(1, new Set(all.map((s) => dayStart(s.start, dayOffset))).size);
  }, [derived, dayOffset]);
  const singleDay = range.end - range.start <= DAY + 2 * 3600_000;
  const filtered = !!(host || catKey || rating || search);

  const clear = () => { setHost(""); setCatKey(""); setRating(""); setSearch(""); };

  return (
    <div className="stack">
      <div className="filters" role="toolbar" aria-label="Filters">
        <div className="seg-control" role="group" aria-label="Time range">
          {PRESETS.map(([p, l]) => (
            <button key={p} aria-pressed={preset === p} onClick={() => setPreset(p)}>{l}</button>
          ))}
        </div>
        {preset === "custom" && (
          <>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </>
        )}
        <div className="seg-control" role="group" aria-label="What to count">
          <button aria-pressed={view === "attention"} onClick={() => setView("attention")} title="One line: the device that had your attention">Attention</button>
          <button aria-pressed={view === "devices"} onClick={() => setView("devices")} title="Every device's own time, overlaps counted on each">All device time</button>
        </div>
        <select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Device">
          <option value="">All devices</option>
          {devices.map((d) => <option key={d.host} value={d.host}>{d.label}</option>)}
        </select>
        <CategorySelect value={catKey} onChange={setCatKey} />
        <select value={rating} onChange={(e) => setRating(e.target.value as Rating | "")} aria-label="Rating">
          <option value="">Any rating</option>
          <option value="productive">Productive</option>
          <option value="neutral">Neutral</option>
          <option value="distracting">Distracting</option>
        </select>
        <input type="search" placeholder="Search app, title, URL" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 210 }} />
        {filtered && <button className="btn" onClick={clear}>Clear filters</button>}
        {act.loading && <span className="muted small">Loading…</span>}
        {act.error && <span className="error small">{act.error}</span>}
      </div>

      <div style={{ opacity: act.loading && act.lanes ? 0.7 : 1 }} className="stack">
        <div className="tiles">
          <Tile label={view === "attention" ? "Attention time" : "Device time"} value={fmtDuration(total)}
            note={`${fmtShortDay(range.start)} – ${fmtShortDay(Math.min(range.end, now) - 1)}`} />
          {!singleDay && (
            <Tile label="Daily average" value={fmtDuration(total / days)} note={`over ${days} day${days === 1 ? "" : "s"} with data`} />
          )}
          <ProductiveTile segs={segs} />
          <TopTile segs={segs} />
        </div>

        <div className="explore-grid">
          <div className="card">
            <div className="card-head">
              <h2>{singleDay ? "Per hour" : "Per day"}</h2>
              <span className="spacer" />
              <div className="seg-control" role="group" aria-label="Stack by">
                {(["category", "rating", "device"] as StackBy[]).map((k) => (
                  <button key={k} aria-pressed={stackBy === k} onClick={() => setStackBy(k)}>{k[0].toUpperCase() + k.slice(1)}</button>
                ))}
              </div>
            </div>
            <ColumnsChart segs={segs} range={range} singleDay={singleDay} stackBy={stackBy} />
          </div>
          <div className="card">
            <h2>Productive, neutral, distracting</h2>
            <RatingSplit totals={ratingTotals(segs)} />
            {singleDay ? (
              <>
                <h2 style={{ marginTop: 22 }}>By category</h2>
                <CategoryBars segs={segs} cats={cats} />
              </>
            ) : (
              <>
                <h2 style={{ marginTop: 22 }}>When, on average</h2>
                <Heatmap minutes={weekHourGrid(segs, { start: range.start, end: Math.min(range.end, now) }).minutes}
                  note="avg per weekday" />
              </>
            )}
          </div>
        </div>

        <FlowCard segs={segs} perHost={view === "devices"} label={label} />

        <div className="card">
          <div className="card-head">
            <h2>Top</h2>
            <span className="spacer" />
            <div className="seg-control" role="group" aria-label="Group by">
              {(["subject", "title", "category", "device"] as GroupBy[]).map((k) => (
                <button key={k} aria-pressed={groupBy === k} onClick={() => setGroupBy(k)}>
                  {k === "subject" ? "App / site" : k[0].toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <TopTable segs={segs} groupBy={groupBy} total={total} label={label}
            onPick={(key) => {
              if (groupBy === "category") setCatKey(key);
              else if (groupBy === "device") setHost(key);
              else setSearch(key);
            }} />
        </div>

        {range.end - range.start <= 7 * DAY + 3600_000 && derived && (
          <div className="card">
            <h2>Day by day</h2>
            <DayStrips segs={segs} range={range} now={now} label={label} />
          </div>
        )}

        <div className="card">
          <h2>Activity log</h2>
          <Log segs={segs} label={label} />
        </div>
      </div>
    </div>
  );
}

function CategorySelect({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  const { cats } = useApp();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Category">
      <option value="">All categories</option>
      {cats.list.map((c) => (
        <option key={c.key} value={c.key}>{" ".repeat(c.depth) + c.leaf}</option>
      ))}
    </select>
  );
}

function ProductiveTile({ segs }: { segs: CSeg[] }) {
  const t = ratingTotals(segs);
  const rated = t.productive + t.distracting;
  return (
    <Tile label="Productive share" value={rated ? `${Math.round((t.productive / rated) * 100)}%` : "–"}
      note={rated ? `of rated time (${fmtDuration(rated)})` : "no rated time yet"} />
  );
}

function TopTile({ segs }: { segs: CSeg[] }) {
  const top = ranked(sumBy(segs, subject))[0];
  return <Tile label="Top app or site" value={top ? top.key : "–"} note={top ? fmtDuration(top.seconds) : undefined} />;
}

const RATING_PARTS: [Rating, string][] = [["productive", "Productive"], ["neutral", "Neutral"], ["distracting", "Distracting"]];

function ColumnsChart({ segs, range, singleDay, stackBy }: { segs: CSeg[]; range: Range; singleDay: boolean; stackBy: StackBy }) {
  const { cats, devices, dayOffset } = useApp();
  const keyOf = (s: CSeg) =>
    stackBy === "category" ? cats.root(s.cat).key : stackBy === "rating" ? (s.home ? "neutral" : s.cat.rating) : s.host;
  // Series in a fixed order, so a series keeps its color whatever is filtered.
  const series: { key: string; label: string; color: string }[] =
    stackBy === "category"
      ? cats.list.filter((c) => c.depth === 0).map((c) => ({ key: c.key, label: c.key, color: slotColor(c.slot) }))
      : stackBy === "rating"
        ? RATING_PARTS.map(([k, l]) => ({ key: k, label: l, color: RATING_COLOR[k] }))
        : devices.map((d, i) => ({ key: d.host, label: d.label, color: i < PALETTE_LIGHT.length ? slotColor(i) : slotColor(null) }));

  const columns: Column[] = useMemo(() => {
    const { keys, totals, fmt } = singleDay
      ? (() => { const r = perHour(segs, range, keyOf); return { keys: r.hours, totals: r.totals, fmt: fmtHour }; })()
      : (() => { const r = perDay(segs, range, dayOffset, keyOf); return { keys: r.days, totals: r.totals, fmt: fmtShortDay }; })();
    return keys.map((k) => ({
      key: k,
      label: fmt(k),
      parts: series.map((s): Part => ({ ...s, seconds: totals.get(k)?.get(s.key) ?? 0 })),
    }));
  }, [segs, range, singleDay, stackBy, cats, devices, dayOffset]);

  const present = series.filter((s) => columns.some((c) => c.parts.some((p) => p.key === s.key && p.seconds > 0)));
  return (
    <>
      <StackedColumns columns={columns} />
      <div className="legend">
        {present.map((s) => (
          <span key={s.key}><span className="swatch" style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
    </>
  );
}

type FlowMode = "where" | "switches";

/** The Sankey card: where the time went, or what each activity led to. */
function FlowCard({ segs, perHost, label }: { segs: CSeg[]; perHost: boolean; label: (h: string) => string }) {
  const { cats } = useApp();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [mode, setMode] = usePref<FlowMode>("explore.flow", "where");
  const [weight, setWeight] = usePref<"time" | "count">("explore.flowWeight", "time");
  // On a phone: no device column and fewer apps, so the labels have room.
  const narrow = width < 560;
  const devices = !narrow && new Set(segs.map((s) => s.host)).size > 1;

  const graph = useMemo(
    () =>
      mode === "where"
        ? whereFlow(segs, cats, { deviceLabel: label, topN: narrow ? 3 : 5, devices })
        : transitionFlow(segs, { weight, perHost, topN: narrow ? 6 : 8, minShare: 0.008 }),
    // label is a fresh closure each render; devices drive it
    [segs, cats, mode, weight, perHost, narrow, devices],
  );
  const titles = mode === "switches" ? ["From", "Then"] : devices ? ["Device", "Category", "App / site"] : ["Category", "App / site"];
  const most = Math.max(0, ...[0, 1, 2].map((c) => graph.nodes.filter((n) => n.col === c).length));
  const height = Math.min(620, Math.max(240, 30 + most * (mode === "switches" ? 38 : 30)));
  const gutters: [number, number] = useMemo(
    () =>
      mode === "switches"
        ? [Math.min(180, width * 0.32), Math.min(180, width * 0.32)]
        : [Math.min(devices ? 120 : 150, width * 0.3), Math.min(210, width * 0.36)],
    [mode, width, devices],
  );

  return (
    <div className="card" ref={ref}>
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <h2>Flow</h2>
        <span className="spacer" />
        {mode === "switches" && (
          <div className="seg-control" role="group" aria-label="Weigh switches by">
            <button aria-pressed={weight === "time"} onClick={() => setWeight("time")} title="Width: time spent after the switch">Time</button>
            <button aria-pressed={weight === "count"} onClick={() => setWeight("count")} title="Width: how many times">Count</button>
          </div>
        )}
        <div className="seg-control" role="group" aria-label="Flow">
          <button aria-pressed={mode === "where"} onClick={() => setMode("where")}>Where time went</button>
          <button aria-pressed={mode === "switches"} onClick={() => setMode("switches")}>What led to what</button>
        </div>
      </div>
      {graph.links.length ? (
        <Sankey graph={graph} titles={titles} height={height} gutters={gutters} />
      ) : (
        <div className="empty">{mode === "where" ? "Nothing matches." : "No switches between categories."}</div>
      )}
      {mode === "switches" && graph.links.length > 0 && (
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          Each switch from one category to another. Stays under a minute and the Home Screen are skipped, breaks
          over 15 minutes end a chain, and the thinnest links are left out. {weight === "time" ? "Width is the time spent after the switch." : "Width is how often."}
        </p>
      )}
    </div>
  );
}

function TopTable({ segs, groupBy, total, label, onPick }: {
  segs: CSeg[]; groupBy: GroupBy; total: number; label: (h: string) => string; onPick: (key: string) => void;
}) {
  const { cats } = useApp();
  const [limit, setLimit] = useState(25);
  const keyFn = (s: CSeg) =>
    groupBy === "category" ? s.cat.key : groupBy === "device" ? s.host : groupBy === "title" ? s.title || s.app : subject(s);
  const rows = ranked(sumBy(segs, keyFn));
  // The category each row mostly belongs to, for its swatch.
  const catOf = new Map<string, Category>();
  if (groupBy !== "category") {
    const tally = new Map<string, Map<Category, number>>();
    for (const s of segs) {
      const k = keyFn(s);
      const m = tally.get(k) ?? new Map<Category, number>();
      m.set(s.cat, (m.get(s.cat) ?? 0) + s.end - s.start);
      tally.set(k, m);
    }
    for (const [k, m] of tally) catOf.set(k, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  }
  if (!rows.length) return <div className="empty">Nothing matches.</div>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{groupBy === "subject" ? "App / site" : groupBy[0].toUpperCase() + groupBy.slice(1)}</th>
            {groupBy !== "category" && <th>Category</th>}
            <th className="r">Time</th>
            <th className="r">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r) => {
            const cat = groupBy === "category" ? cats.byKey.get(r.key) : catOf.get(r.key);
            return (
              <tr key={r.key} className="clickable" onClick={() => onPick(r.key)} title="Filter to this">
                <td className="clip">{groupBy === "device" ? label(r.key) : r.key.replace(/\.exe$/i, "")}</td>
                {groupBy !== "category" && (
                  <td className="clip">
                    {cat && <span className="swatch" style={{ background: slotColor(cat.slot), marginRight: 6 }} />}
                    {cat?.name.join(" › ")}
                  </td>
                )}
                <td className="r">{fmtDuration(r.seconds)}</td>
                <td className="r">{total ? `${((r.seconds / total) * 100).toFixed(1)}%` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > limit && (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 50)}>
          Show more ({rows.length - limit} left)
        </button>
      )}
    </div>
  );
}

/** One strip per day with data, newest first, sharing the axis at the bottom. */
function DayStrips({ segs, range, now, label }: { segs: CSeg[]; range: Range; now: number; label: (h: string) => string }) {
  const { dayOffset } = useApp();
  const days: { start: number; end: number; segs: CSeg[] }[] = [];
  for (let d = range.start; d < range.end && d < now; d = addDays(d, 1, dayOffset)) {
    const end = addDays(d, 1, dayOffset);
    const lane = segs.filter((s) => s.end > d && s.start < end);
    if (lane.length) days.push({ start: d, end, segs: lane });
  }
  if (!days.length) return <div className="empty">Nothing matches.</div>;
  return (
    <div className="stack" style={{ gap: 0 }}>
      {days.reverse().map((d, i) => (
        <Timeline key={d.start} range={d} now={now} laneHeight={20} showAxis={i === days.length - 1}
          lanes={[{ label: fmtShortDay(d.start), segs: d.segs }]} deviceLabel={label} />
      ))}
    </div>
  );
}

function Log({ segs, label }: { segs: CSeg[]; label: (h: string) => string }) {
  const [limit, setLimit] = useState(100);
  const rows = useMemo(() => coalesce([...segs].sort((a, b) => a.start - b.start)).reverse(), [segs]);
  if (!rows.length) return <div className="empty">Nothing matches.</div>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Start</th>
            <th className="r">Duration</th>
            <th>Device</th>
            <th>App / site</th>
            <th>Title</th>
            <th>Category</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((s, i) => (
            <tr key={`${s.host}-${s.start}-${i}`}>
              <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtShortDay(s.start)} {fmtTime(s.start)}</td>
              <td className="r">{fmtDuration((s.end - s.start) / 1000)}</td>
              <td>{label(s.host)}</td>
              <td className="clip">{subject(s).replace(/\.exe$/i, "")}</td>
              <td className="clip secondary" title={s.url ?? s.title}>{s.title}</td>
              <td className="clip">
                <span className="swatch" style={{ background: slotColor(s.cat.slot), marginRight: 6 }} />
                {s.cat.name.join(" › ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 200)}>
          Show more ({rows.length - limit} left)
        </button>
      )}
    </div>
  );
}
