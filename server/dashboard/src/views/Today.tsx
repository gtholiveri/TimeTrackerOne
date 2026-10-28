// The glance view: what each device is doing now, today's total and how it
// splits, and the day as a zoomable line (see FlowTimeline) that keeps going
// into the days before and after.

import { useMemo, useState } from "react";
import type { Device, Seg } from "../lib/activity";
import { FlowTimeline } from "../components/FlowTimeline";
import { visibleRange } from "../components/Timeline";
import { sumBy } from "../lib/aggregate";
import type { AWEvent, TTState } from "../lib/api";
import { choose, isBackground } from "../lib/attention";
import { derive, useApp, useDays, useLiveState, useNow, type DayActivity, type Derived, type Lane } from "../lib/store";
import { HOUR, MINUTE, addDays, dayStart, fmtAgo, fmtDay, fmtDuration, fmtShortDay, fmtTime } from "../lib/time";
import { CategoryBars, RatingSplit, ratingTotals } from "../components/Figures";
import { slotColor } from "../lib/palette";

export function Today() {
  const { cats, attention, dayOffset, devices } = useApp();
  const now = useNow(30_000);
  const today = dayStart(now, dayOffset);
  // The day the page is about: picked with the arrows, or the one the
  // timeline's window is centred in. null follows today (across midnight too).
  const [pick, setPick] = useState<number | null>(null);
  const focus = pick ?? today;
  const isToday = focus === today;
  // Days loaded for the timeline: the focused one and its neighbours, grown
  // a day at a time as the window nears either end.
  const around = (d: number) => ({ first: addDays(d, -1, dayOffset), last: Math.min(today, addDays(d, 1, dayOffset)) });
  const [win, setWin] = useState(() => around(focus));
  const [jump, setJump] = useState(0);
  // On today the window always reaches it, even after midnight moves "today".
  const lastDay = isToday ? today : Math.min(win.last, today);
  const days = useDays(win.first, lastDay);
  const live = useLiveState();
  const label = (host: string) => devices.find((d) => d.host === host)?.label ?? host;

  // Categorized once per loaded day (a refetch of today leaves the others be).
  const cache = useMemo(() => new WeakMap<DayActivity, Derived>(), [cats, attention]);
  const derivedOf = (d: number) => {
    const a = days.days.get(d);
    if (!a) return null;
    let out = cache.get(a);
    if (!out) cache.set(a, (out = derive(a.lanes, cats, attention)));
    return out;
  };

  const focusAct = days.days.get(focus) ?? null;
  const derived = derivedOf(focus);
  const merged = derived?.merged ?? [];
  const total = merged.reduce((a, s) => a + (s.end - s.start) / 1000, 0);
  const byDevice = [...sumBy(merged, (s) => s.host)].sort((a, b) => b[1] - a[1]);

  // The timeline gets every loaded day joined end to end.
  const line = useMemo(() => {
    const loaded: Derived[] = [];
    for (let d = win.first; d <= lastDay; d = addDays(d, 1, dayOffset)) {
      const x = derivedOf(d);
      if (x) loaded.push(x);
    }
    return {
      segs: loaded.flatMap((x) => x.merged),
      lanes: devices.map((dev) => ({
        label: dev.label,
        segs: loaded.flatMap((x) => x.lanes.find((l) => l.device.host === dev.host)?.segs ?? []),
      })),
    };
  }, [days.days, cache, win.first, lastDay, dayOffset, devices]);

  const focusRange = { start: focus, end: addDays(focus, 1, dayOffset) };
  const fit = visibleRange(focusRange, derived?.lanes.flatMap((l) => l.segs) ?? [], isToday ? now : null);
  const hourAfterNow = new Date(now + 15 * MINUTE).setMinutes(0, 0, 0) + HOUR;
  const bounds = { start: win.first, end: Math.min(addDays(lastDay, 1, dayOffset), hourAfterNow) };

  const go = (d: number) => {
    const day = Math.min(d, today);
    setPick(day === today ? null : day);
    setWin(around(day));
    setJump((n) => n + 1);
  };
  // Moving the window: the page follows the day it's centred in, and the next
  // day out loads before the window gets there.
  const onView = (v: { start: number; end: number }) => {
    const d = dayStart((v.start + v.end) / 2, dayOffset);
    setPick(d >= today ? null : d);
    setWin((w) => {
      const first = v.start - w.first < 12 * HOUR ? addDays(w.first, -1, dayOffset) : w.first;
      const last = w.last < today && addDays(w.last, 1, dayOffset) - v.end < 12 * HOUR ? addDays(w.last, 1, dayOffset) : w.last;
      return first === w.first && last === w.last ? w : { first, last };
    });
  };

  return (
    <div className="stack">
      <div className="day-nav">
        <button className="icon-btn" onClick={() => go(addDays(focus, -1, dayOffset))} aria-label="Previous day">‹</button>
        <h1>{isToday ? "Today" : fmtDay(focus)}</h1>
        <button className="icon-btn" onClick={() => go(addDays(focus, 1, dayOffset))} disabled={isToday} aria-label="Next day">›</button>
        {!isToday && <button className="btn" onClick={() => go(today)}>Today</button>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted small" title={days.error ?? undefined}>
          <span className={`live-dot${days.error ? " stale" : ""}`} />{" "}
          {days.error ? "Couldn't refresh" : focusAct ? `Updated ${fmtAgo(focusAct.loadedAt, now)}` : "Loading…"}
        </span>
        <button className="icon-btn" onClick={days.reload} aria-label="Refresh">↻</button>
      </div>

      {days.error && !focusAct && <div className="card error">Couldn't load activity: {days.error}</div>}

      {isToday && focusAct && <NowCards lanes={focusAct.lanes} live={live} now={now} />}

      <div className="today-grid" style={{ opacity: days.loading && focusAct ? 0.85 : 1 }}>
        <div className="card">
          <h2>{isToday ? "On screens today" : "On screens"}</h2>
          <div className="hero">{fmtDuration(total)}</div>
          <div className="hero-sub">
            {byDevice.length
              ? byDevice.map(([host, sec]) => `${label(host)} ${fmtDuration(sec)}`).join(" · ")
              : focusAct ? "Nothing yet" : "Loading…"}
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
        {line.segs.length || focusAct ? (
          <FlowTimeline
            title={isToday ? "Today" : fmtShortDay(focus)}
            bounds={bounds}
            fit={fit}
            jump={jump}
            onView={onView}
            now={now}
            segs={line.segs}
            lanes={line.lanes}
            deviceLabel={label}
          />
        ) : (
          <>
            <h2>{isToday ? "Today" : fmtShortDay(focus)}</h2>
            <div className="empty">Loading…</div>
          </>
        )}
      </div>
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
