// The glance view: what each device is doing now, today's total and how it
// splits, and the day as a strip (merged, or one lane per device).

import { useMemo, useState } from "react";
import type { Device, Seg } from "../lib/activity";
import { Timeline, visibleRange } from "../components/Timeline";
import { sumBy, type CSeg } from "../lib/aggregate";
import type { AWEvent, TTState } from "../lib/api";
import { choose, isBackground } from "../lib/attention";
import { useActivity, useApp, useDerived, useLiveState, useNow, type Lane } from "../lib/store";
import { MINUTE, addDays, dayStart, fmtAgo, fmtDay, fmtDuration, fmtTime } from "../lib/time";
import { CategoryBars, RatingSplit, ratingTotals } from "../components/Figures";
import { slotColor } from "../lib/palette";
import { usePref } from "../components/usePref";

export function Today() {
  const { cats, attention, dayOffset, devices } = useApp();
  const now = useNow(30_000);
  const [shift, setShift] = useState(0);
  const today = dayStart(now, dayOffset);
  const range = useMemo(() => {
    const start = addDays(today, shift, dayOffset);
    return { start, end: addDays(start, 1, dayOffset) };
  }, [today, shift, dayOffset]);
  const isToday = shift === 0;
  const act = useActivity(range);
  const derived = useDerived(act.lanes, cats, attention);
  const live = useLiveState();
  const [mode, setMode] = usePref<"merged" | "lanes">("today.mode", "merged");
  const label = (host: string) => devices.find((d) => d.host === host)?.label ?? host;

  const merged = derived?.merged ?? [];
  const total = merged.reduce((a, s) => a + (s.end - s.start) / 1000, 0);
  const byDevice = [...sumBy(merged, (s) => s.host)].sort((a, b) => b[1] - a[1]);

  return (
    <div className="stack">
      <div className="day-nav">
        <button className="icon-btn" onClick={() => setShift(shift - 1)} aria-label="Previous day">‹</button>
        <h1>{isToday ? "Today" : fmtDay(range.start)}</h1>
        <button className="icon-btn" onClick={() => setShift(shift + 1)} disabled={isToday} aria-label="Next day">›</button>
        {!isToday && <button className="btn" onClick={() => setShift(0)}>Today</button>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted small" title={act.error ?? undefined}>
          <span className={`live-dot${act.error ? " stale" : ""}`} />{" "}
          {act.error ? "Couldn't refresh" : act.loadedAt ? `Updated ${fmtAgo(act.loadedAt, now)}` : "Loading…"}
        </span>
        <button className="icon-btn" onClick={act.reload} aria-label="Refresh">↻</button>
      </div>

      {act.error && !act.lanes && <div className="card error">Couldn't load activity: {act.error}</div>}

      {isToday && act.lanes && <NowCards lanes={act.lanes} live={live} now={now} />}

      <div className="today-grid" style={{ opacity: act.loading && act.lanes ? 0.7 : 1 }}>
        <div className="card">
          <h2>{isToday ? "On screens today" : "On screens"}</h2>
          <div className="hero">{fmtDuration(total)}</div>
          <div className="hero-sub">
            {byDevice.length
              ? byDevice.map(([host, sec]) => `${label(host)} ${fmtDuration(sec)}`).join(" · ")
              : act.lanes ? "Nothing yet" : "Loading…"}
          </div>
          <div style={{ marginTop: 18 }}>
            <RatingSplit totals={ratingTotals(merged)} />
          </div>
        </div>
        <div className="card">
          <h2>By category</h2>
          {derived ? <CategoryBars segs={merged} cats={cats} /> : <div className="empty">Loading…</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{isToday ? "Today" : "The day"}</h2>
          <span className="spacer" />
          <div className="seg-control" role="group" aria-label="Timeline layout">
            <button aria-pressed={mode === "merged"} onClick={() => setMode("merged")}>Merged</button>
            <button aria-pressed={mode === "lanes"} onClick={() => setMode("lanes")}>By device</button>
          </div>
        </div>
        {derived ? (
          <>
            <Timeline
              range={visibleRange(range, derived.lanes.flatMap((l) => l.segs), isToday ? now : null)}
              now={isToday ? now : undefined}
              lanes={
                mode === "merged"
                  ? [{ label: "You", segs: derived.merged }]
                  : derived.lanes.map((l) => ({ label: l.device.label, segs: l.segs }))
              }
              laneHeight={mode === "merged" ? 34 : 26}
              deviceLabel={label}
            />
            <TimelineLegend segs={mode === "merged" ? derived.merged : derived.lanes.flatMap((l) => l.segs)} />
          </>
        ) : (
          <div className="empty">Loading…</div>
        )}
      </div>
    </div>
  );
}

function TimelineLegend({ segs }: { segs: CSeg[] }) {
  const { cats } = useApp();
  const roots = new Map<string, number>();
  for (const s of segs) {
    const r = cats.root(s.cat);
    roots.set(r.key, (roots.get(r.key) ?? 0) + (s.end - s.start));
  }
  const shown = cats.list.filter((c) => c.depth === 0 && roots.has(c.key));
  if (!shown.length) return null;
  return (
    <div className="legend">
      {shown.map((c) => (
        <span key={c.key}>
          <span className="swatch" style={{ background: slotColor(c.slot) }} />
          {c.key}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ now

interface NowState {
  device: Device;
  what: string;
  detail: string;
  since: number | null;
  seg: Seg | null; // what counts toward attention right now
  stale?: string;
}

function phoneNow(device: Device, live: TTState | null, now: number): NowState {
  const entry = live && Object.values(live.devices).find((d) => d.host === device.host);
  const cur = entry?.current;
  const heard = entry?.last_received ? entry.last_received * 1000 : null;
  const stale = heard && now - heard > 30 * MINUTE ? `last heard ${fmtAgo(heard, now)}` : undefined;
  if (!cur) return { device, what: live ? "No data" : "…", detail: "", since: null, seg: null, stale };
  const since = Date.parse(cur.start);
  if (cur.state === "locked") return { device, what: "Locked", detail: "", since, seg: null, stale };
  const app = cur.state === "home" ? "Home Screen" : cur.app ?? "?";
  const seg: Seg = { start: since, end: now, host: device.host, kind: "phone", app, title: "", home: cur.state === "home" };
  return { device, what: app, detail: entry?.safari_page && app === "Safari" ? entry.safari_page.title : "", since, seg, stale };
}

const endOf = (e: AWEvent) => Date.parse(e.timestamp) + e.duration * 1000;
const latest = (events: AWEvent[]) =>
  events.reduce<AWEvent | undefined>((a, e) => (!a || Date.parse(e.timestamp) > Date.parse(a.timestamp) ? e : a), undefined);

/** The laptop's state from today's events. The mirror copies once a minute, so
 *  "now" here can be a minute behind; past five minutes it's off or asleep. */
function desktopNow(lane: Lane, now: number): NowState {
  const { device, raw, segs } = lane;
  const newest = Math.max(0, ...raw.afk.map(endOf), ...raw.window.map(endOf));
  if (!newest) return { device, what: "No data today", detail: "", since: null, seg: null };
  if (now - newest > 5 * MINUTE) {
    return { device, what: "Off or asleep", detail: "", since: newest, seg: null, stale: `no data since ${fmtTime(newest)}` };
  }
  const afk = latest(raw.afk);
  if (afk?.data.status === "afk") return { device, what: "Away", detail: "", since: Date.parse(afk.timestamp), seg: null };
  const last = segs[segs.length - 1];
  if (!last) return { device, what: "Idle", detail: "", since: null, seg: null };
  return { device, what: last.domain ?? last.app.replace(/\.exe$/i, ""), detail: last.title, since: last.start, seg: last };
}

function NowCards({ lanes, live, now }: { lanes: Lane[]; live: TTState | null; now: number }) {
  const { attention, cats } = useApp();
  const states = lanes.map((l) => (l.device.kind === "phone" ? phoneNow(l.device, live, now) : desktopNow(l, now)));
  const phone = states.find((s) => s.device.kind === "phone")?.seg ?? null;
  const desktop = states.find((s) => s.device.kind === "desktop")?.seg ?? null;
  const winner = choose(phone, desktop, attention);
  return (
    <div className="now-cards">
      {states.map((s) => {
        const cat = s.seg ? cats.categorize(s.seg) : null;
        const background = s.seg && s.device.kind === "phone" && !s.seg.home && isBackground(s.seg.app, attention);
        return (
          <div key={s.device.host} className={`card now-card${winner && winner === s.seg ? " attention" : ""}`}>
            <div className="device">
              {cat ? <span className="dot" style={{ background: slotColor(cat.slot) }} /> : <span className="dot" style={{ background: "var(--idle)" }} />}
              {s.device.label}
              {winner && winner === s.seg && <span className="badge">has your attention</span>}
              {background && <span className="badge">background</span>}
            </div>
            <div className="what">{s.what}</div>
            <div className="detail small">
              {s.detail && <>{s.detail} · </>}
              {s.since ? `since ${fmtTime(s.since)} · ${fmtDuration((now - s.since) / 1000)}` : ""}
              {s.stale && <span className="muted"> ({s.stale})</span>}
            </div>
            {cat && <div className="small muted" style={{ marginTop: 4 }}>{cat.name.join(" › ")}</div>}
          </div>
        );
      })}
    </div>
  );
}
