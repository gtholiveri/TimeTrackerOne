// One day with every stream the relay has, on one clock: screen time per
// device, Claude, places and GPS, motion, WHOOP and the TT Watch runs.
// Hover a bar for what it was; the lists below give the same in full.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Tooltip, type TipState } from "../components/Tooltip";
import { useWidth } from "../components/useWidth";
import {
  api,
  type ActivityAnswer,
  type ActivitySeg,
  type ClaudeBlock,
  type ClaudeBlocks,
  type Coverage,
  type DayStory,
  type WhoopRecord,
} from "../lib/api";
import { fixTimes, motionStretches, parseLine, pauses, visits, type Line, type Stretch, type Visit } from "../lib/fused";
import { slotColor } from "../lib/palette";
import { useApp, useNow } from "../lib/store";
import { DAY, HOUR, MINUTE, addDays, dayStart, fmtAgo, fmtDay, fmtDuration, fmtTime } from "../lib/time";

interface DayData {
  activity: ActivityAnswer | null;
  claude: ClaudeBlocks | null;
  lines: Line[];
  whoop: { sleep: WhoopRecord[]; workout: WhoopRecord[]; recovery: WhoopRecord[]; cycle: WhoopRecord[] };
  coverage: Coverage | null;
  errors: string[];
  loadedAt: number;
}

/** Every stream for [start, end), each fetched on its own so one failing leaves the rest. */
function useDayData(start: number, end: number, refreshMs = 60_000) {
  const [data, setData] = useState<DayData | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  useEffect(() => {
    let live = true;
    const until = Math.min(end, Date.now());
    const back = Math.max(1, Math.ceil((Date.now() - start) / DAY) + 1); // WHOOP and coverage count days back from now
    const errors: string[] = [];
    const soft = <T,>(what: string, p: Promise<T>, empty: T): Promise<T> =>
      p.catch((e: Error) => {
        errors.push(`${what}: ${e.message}`);
        return empty;
      });
    Promise.all([
      soft("Screen time", api.activity(start, until, "devices"), null),
      soft("Claude", api.claudeBlocks(start, until), null),
      soft("Phone lines", api.lines(start, until, ["visit", "loc", "locpause", "motion"]), [] as string[]),
      soft("WHOOP sleep", api.whoop("sleep", back), [] as WhoopRecord[]),
      soft("WHOOP workouts", api.whoop("workout", back), [] as WhoopRecord[]),
      soft("WHOOP recovery", api.whoop("recovery", back), [] as WhoopRecord[]),
      soft("WHOOP cycles", api.whoop("cycle", back), [] as WhoopRecord[]),
      soft("Coverage", api.coverage(back), null),
    ]).then(([activity, claude, raw, sleep, workout, recovery, cycle, coverage]) => {
      if (!live) return;
      setData({
        activity,
        claude,
        lines: raw.map(parseLine).filter((l): l is Line => l !== null),
        whoop: { sleep, workout, recovery, cycle },
        coverage,
        errors,
        loadedAt: Date.now(),
      });
    });
    return () => {
      live = false;
    };
  }, [start, end, tick]);
  return { data, reload: () => setTick((n) => n + 1) };
}

// ------------------------------------------------------------------ lanes

interface Bar {
  start: number;
  end: number;
  color: string;
  tip: ReactNode;
  /** A thin tick instead of a bar (GPS fixes). */
  tick?: boolean;
}

interface LaneSpec {
  label: string;
  bars: Bar[];
  empty: string;
}

const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const range = (a: number, b: number) => `${fmtTime(a)} – ${fmtTime(b)}`;
const mins = (ms: number) => fmtDuration(ms / 1000);

const KIND_COLOR: Record<string, string> = {
  building: "var(--cat-0)",
  debugging: "var(--cat-1)",
  planning: "var(--cat-2)",
  learning: "var(--cat-6)",
  writing: "var(--cat-3)",
  venting: "var(--cat-7)",
  chatting: "var(--cat-4)",
};

const MOTION_COLOR: Record<string, string> = {
  walking: "var(--cat-2)",
  running: "var(--cat-5)",
  cycling: "var(--cat-3)",
  automotive: "var(--cat-6)",
};

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="t-row">
      <span className="grow">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function claudeTip(b: ClaudeBlock): ReactNode {
  const s = t(b.start);
  const e = t(b.end);
  return (
    <>
      <div className="t-title">{b.label ?? "Claude"}</div>
      <div className="small secondary">
        {range(s, e)} · {mins(e - s)}{b.kind ? ` · ${b.kind}` : ""}{b.verdict ? ` · ${b.verdict}` : ""}
      </div>
      {b.summary && <p className="small" style={{ margin: "6px 0" }}>{b.summary}</p>}
      {b.sessions.slice(0, 4).map((x) => (
        <Row key={x.title + x.surface} k={x.title} v={`${x.you} typed`} />
      ))}
      {b.typed.slice(-2).map((m) => (
        <div key={m.ts} className="small secondary" style={{ marginTop: 4 }}>“{clip(m.text, 120)}”</div>
      ))}
    </>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function whoopSleepHours(r: WhoopRecord): number | null {
  const st = (r.score as { stage_summary?: Record<string, number> } | null)?.stage_summary;
  if (!st) return null;
  const asleep = (st.total_light_sleep_time_milli ?? 0) + (st.total_slow_wave_sleep_time_milli ?? 0) +
    (st.total_rem_sleep_time_milli ?? 0);
  return asleep / HOUR;
}

const num = (r: WhoopRecord | undefined, k: string): number | null => {
  const v = (r?.score as Record<string, unknown> | null | undefined)?.[k];
  return typeof v === "number" ? v : null;
};

// ------------------------------------------------------------------ view

export function Day() {
  const { cats, dayOffset, devices } = useApp();
  const now = useNow(30_000);
  const today = dayStart(now, dayOffset);
  const [day, setDay] = useState(today);
  const isToday = day === today;
  const end = addDays(day, 1, dayOffset);
  const until = Math.min(end, now);
  const { data, reload } = useDayData(day, end);
  const [ref, width] = useWidth<HTMLDivElement>(900);
  const [tip, setTip] = useState<TipState | null>(null);

  const label = (host: string) => devices.find((d) => d.host === host)?.label ?? host;
  const catColor = (category: string) => {
    const c = cats.byKey.get(category);
    return slotColor(c ? cats.root(c).slot : null);
  };

  const derived = useMemo(() => {
    if (!data) return null;
    const segs = data.activity?.segments ?? [];
    const hosts = [...new Set(segs.map((s) => s.device))];
    const claude = data.claude?.blocks ?? [];
    const moves = motionStretches(data.lines, until);
    const vis = visits(data.lines, day, until);
    const fixes = fixTimes(data.lines);
    const inDay = (r: WhoopRecord) => t(r.end ?? undefined) > day && t(r.start) < end;
    const sleeps = data.whoop.sleep.filter(inDay);
    const workouts = data.whoop.workout.filter(inDay);
    // The morning's recovery: the one WHOOP scored for the sleep that ended in this day.
    const recovery = data.whoop.recovery.find((r) => sleeps.some((s) => s.id === r.sleep_id && !s.nap)) ??
      data.whoop.recovery.find((r) => t(r.created_at) >= day && t(r.created_at) < end);
    const cycle = data.whoop.cycle.find((c) => t(c.start) < end && (c.end == null || t(c.end) > day));
    const runs = (data.coverage?.watch_runs ?? []).filter((r) => t(r.last) >= day && t(r.first) < end);
    return { segs, hosts, claude, moves, vis, fixes, sleeps, workouts, recovery, cycle, runs };
  }, [data, day, end, until]);

  const lanes: LaneSpec[] = derived
    ? [
        ...(derived.hosts.length ? derived.hosts : ["—"]).map((host) => ({
          label: label(host),
          empty: "No screen time",
          bars: derived.segs
            .filter((s) => s.device === host)
            .map((s: ActivitySeg) => ({
              start: t(s.start),
              end: t(s.end),
              color: catColor(s.category),
              tip: (
                <>
                  <div className="t-title">{s.app}</div>
                  {(s.domain || s.title) && <div className="small secondary">{clip(s.domain || s.title, 80)}</div>}
                  <Row k={range(t(s.start), t(s.end))} v={fmtDuration(s.seconds)} />
                  <Row k="Category" v={s.category} />
                </>
              ),
            })),
        })),
        {
          label: "Claude",
          empty: "No Claude",
          bars: derived.claude.map((b) => ({
            start: t(b.start),
            end: t(b.end),
            color: (b.kind && KIND_COLOR[b.kind]) || "var(--accent)",
            tip: claudeTip(b),
          })),
        },
        {
          label: "Places",
          empty: "No visits",
          bars: [
            ...derived.vis.map((v: Visit) => ({
              start: v.start,
              end: v.end,
              color: slotColor(v.place.charCodeAt(0) % 8),
              tip: (
                <>
                  <div className="t-title">Place {v.place}</div>
                  <Row k={range(v.start, v.end)} v={mins(v.end - v.start)} />
                  {v.ongoing && <div className="small secondary">Still there</div>}
                </>
              ),
            })),
          ],
        },
        {
          label: "GPS fixes",
          empty: "No fixes",
          bars: derived.fixes.map((f) => ({
            start: f,
            end: f,
            tick: true,
            color: "var(--ink-2)",
            tip: <div className="t-title">GPS fix at {fmtTime(f)}</div>,
          })),
        },
        {
          label: "Motion",
          empty: "Not moving",
          bars: derived.moves.map((m: Stretch) => ({
            start: m.start,
            end: m.end,
            color: MOTION_COLOR[m.what] ?? "var(--cat-none)",
            tip: (
              <>
                <div className="t-title">{m.what[0].toUpperCase() + m.what.slice(1)}</div>
                <Row k={range(m.start, m.end)} v={mins(m.end - m.start)} />
              </>
            ),
          })),
        },
        {
          label: "WHOOP",
          empty: "No sleep or workouts",
          bars: [
            ...derived.sleeps.map((s) => ({
              start: t(s.start),
              end: t(s.end ?? undefined),
              color: "var(--seq-5)",
              tip: (
                <>
                  <div className="t-title">{s.nap ? "Nap" : "Sleep"}</div>
                  <Row k={range(t(s.start), t(s.end ?? undefined))} v={mins(t(s.end ?? undefined) - t(s.start))} />
                  {whoopSleepHours(s) !== null && <Row k="Asleep" v={`${whoopSleepHours(s)!.toFixed(1)} h`} />}
                  {num(s, "sleep_performance_percentage") !== null && (
                    <Row k="Performance" v={`${num(s, "sleep_performance_percentage")}%`} />
                  )}
                </>
              ),
            })),
            ...derived.workouts.map((w) => ({
              start: t(w.start),
              end: t(w.end ?? undefined),
              color: "var(--cat-7)",
              tip: (
                <>
                  <div className="t-title">{w.sport_name ?? "Workout"}</div>
                  <Row k={range(t(w.start), t(w.end ?? undefined))} v={mins(t(w.end ?? undefined) - t(w.start))} />
                  {num(w, "strain") !== null && <Row k="Strain" v={num(w, "strain")!.toFixed(1)} />}
                  {num(w, "average_heart_rate") !== null && <Row k="Avg heart rate" v={num(w, "average_heart_rate")} />}
                </>
              ),
            })),
          ],
        },
        {
          label: "TT Watch",
          empty: "No runs",
          bars: derived.runs.map((r) => ({
            start: t(r.first),
            end: Math.max(t(r.last), t(r.first) + MINUTE),
            color: r.ended ? "var(--cat-none)" : "var(--good-text)",
            tip: (
              <>
                <div className="t-title">TT Watch run {r.run}</div>
                <Row k={range(t(r.first), t(r.last))} v={mins(t(r.last) - t(r.first))} />
                <Row k="Lines" v={r.lines} />
                <Row k="Ended" v={r.ended ? "yes" : "no"} />
              </>
            ),
          })),
        },
      ]
    : [];

  // ---- geometry
  const LABEL = 118;
  const ROW = 26;
  const TOP = 22;
  const inner = Math.max(200, width - LABEL - 8);
  // Today stops an hour past now instead of drawing the empty rest of the day.
  const axisEnd = isToday ? Math.min(end, Math.ceil((now + 30 * MINUTE) / HOUR) * HOUR) : end;
  const x = (ms: number) => LABEL + ((Math.min(Math.max(ms, day), axisEnd) - day) / (axisEnd - day)) * inner;
  const step = (axisEnd - day) / HOUR <= 10 ? HOUR : (axisEnd - day) / HOUR <= 16 ? 2 * HOUR : 3 * HOUR;
  const hours: number[] = [];
  for (let h = day; h <= axisEnd; h += step) hours.push(h);
  const height = TOP + lanes.length * ROW + 6;

  const totals = derived && {
    screen: derived.segs.reduce((a, s) => a + s.seconds, 0),
    claude: derived.claude.reduce((a, b) => a + b.seconds, 0),
    moving: derived.moves.reduce((a, m) => a + (m.end - m.start) / 1000, 0),
  };

  return (
    <div className="stack">
      <div className="day-nav">
        <button className="icon-btn" onClick={() => setDay(addDays(day, -1, dayOffset))} aria-label="Previous day">‹</button>
        <h1>{isToday ? "Today" : fmtDay(day)}</h1>
        <button className="icon-btn" onClick={() => setDay(addDays(day, 1, dayOffset))} disabled={isToday} aria-label="Next day">›</button>
        {!isToday && <button className="btn" onClick={() => setDay(today)}>Today</button>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted small">{data ? `Updated ${fmtAgo(data.loadedAt, now)}` : "Loading…"}</span>
        <button className="icon-btn" onClick={reload} aria-label="Refresh">↻</button>
      </div>

      {data?.errors.map((e) => <div key={e} className="card error">{e}</div>)}

      <StoryCard day={localDate(day)} isToday={isToday} />

      <div className="day-stats">
        <Stat label="On screens" value={totals ? fmtDuration(totals.screen) : "…"} />
        <Stat label="In Claude" value={totals ? fmtDuration(totals.claude) : "…"} />
        <Stat label="Moving" value={totals ? fmtDuration(totals.moving) : "…"} />
        <Stat
          label="Recovery"
          value={num(derived?.recovery, "recovery_score") !== null ? `${num(derived?.recovery, "recovery_score")}%` : "—"}
          sub={derived?.recovery ? `HRV ${num(derived.recovery, "hrv_rmssd_milli")?.toFixed(0)} ms · RHR ${num(derived.recovery, "resting_heart_rate")}` : undefined}
        />
        <Stat
          label="Sleep"
          value={derived?.sleeps.find((s) => !s.nap) ? `${whoopSleepHours(derived.sleeps.find((s) => !s.nap)!)?.toFixed(1)} h` : "—"}
          sub={derived?.cycle ? `Day strain ${num(derived.cycle, "strain")?.toFixed(1)}` : undefined}
        />
      </div>

      <div className="card">
        <h2>The day, every stream</h2>
        <div ref={ref} className="chart" onMouseLeave={() => setTip(null)}>
          {!data ? (
            <div className="empty">Loading…</div>
          ) : (
            <svg width={width} height={height} role="img" aria-label="Timeline of the day">
              {hours.map((h) => (
                <g key={h}>
                  <line className="gridline" x1={x(h)} x2={x(h)} y1={TOP - 4} y2={height - 4} />
                  <text x={x(h)} y={12} textAnchor="middle" className="small">{fmtTime(h)}</text>
                </g>
              ))}
              {isToday && <line className="now-line" x1={x(now)} x2={x(now)} y1={TOP - 4} y2={height - 4} />}
              {lanes.map((lane, i) => {
                const y = TOP + i * ROW;
                return (
                  <g key={lane.label + i}>
                    <text className="lane-label" x={0} y={y + ROW / 2 + 4}>{clip(lane.label, 17)}</text>
                    <rect x={LABEL} y={y + 4} width={inner} height={ROW - 8} fill="var(--idle)" rx={3} opacity={0.5} />
                    {lane.bars.length === 0 && (
                      <text x={LABEL + 6} y={y + ROW / 2 + 4} className="small" fill="var(--muted)">{lane.empty}</text>
                    )}
                    {lane.bars.map((b, j) => {
                      const x0 = x(b.start);
                      const w = b.tick ? 1.5 : Math.max(2, x(b.end) - x0);
                      return (
                        <rect key={j} x={x0} y={y + 4} width={w} height={ROW - 8} fill={b.color} rx={b.tick ? 0 : 2}
                          opacity={b.tick ? 0.5 : 1}
                          onMouseMove={(ev) => {
                            const box = (ev.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                            setTip({ x: ev.clientX - box.left, y: ev.clientY - box.top + 12, content: b.tip });
                          }} />
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          )}
          <Tooltip tip={tip} width={width} />
        </div>
        {data?.claude?.label_notes?.length ? (
          <p className="small secondary">Claude labels missing: {data.claude.label_notes.join("; ")}</p>
        ) : null}
      </div>

      {derived && (
        <>
          <ClaudeList blocks={derived.claude} />
          <div className="today-grid">
            <PlacesList vis={derived.vis} fixes={derived.fixes.length} paused={pauses(data!.lines).length} />
            <WhoopList sleeps={derived.sleeps} workouts={derived.workouts} />
          </div>
          <RunsList runs={derived.runs} coverage={data!.coverage} day={day} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <h2>{label}</h2>
      <div className="hero">{value}</div>
      {sub && <div className="hero-sub">{sub}</div>}
    </div>
  );
}

function ClaudeList({ blocks }: { blocks: ClaudeBlock[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>Claude</h2>
      {blocks.length === 0 ? (
        <div className="empty">No time in Claude this day</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>When</th><th className="r">Time</th><th>What you were doing</th><th>Kind</th><th>Sessions</th></tr>
            </thead>
            <tbody>
              {blocks.map((b) => {
                const s = t(b.start);
                const e = t(b.end);
                const isOpen = open === b.start;
                return (
                  <Fragment key={b.start}>
                    <tr className="clickable" onClick={() => setOpen(isOpen ? null : b.start)}>
                      <td>{range(s, e)}</td>
                      <td className="r">{fmtDuration(b.seconds)}</td>
                      <td>
                        <div>
                          {b.project && b.goal ? (
                            <><strong>{b.project}</strong> · {b.goal}</>
                          ) : (
                            b.label ?? <span className="muted">No label</span>
                          )}
                        </div>
                        {b.summary && <div className="small secondary">{b.summary}</div>}
                      </td>
                      <td>
                        {b.kind ?? ""}
                        {b.verdict && <div className={`small verdict-${b.verdict}`}>{b.verdict}</div>}
                      </td>
                      <td className="small">{b.sessions.map((x) => x.title).join(", ") || <span className="muted">none synced</span>}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5}>
                          {b.typed.length === 0 ? (
                            <span className="muted small">Nothing typed</span>
                          ) : (
                            b.typed.map((m) => (
                              <div key={m.ts} className="small" style={{ margin: "4px 0" }}>
                                <span className="muted">{fmtTime(Date.parse(m.ts))} · {m.session}</span> — {clip(m.text, 400)}
                              </div>
                            ))
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PlacesList({ vis, fixes, paused }: { vis: Visit[]; fixes: number; paused: number }) {
  return (
    <div className="card">
      <h2>Places</h2>
      <p className="small secondary">{fixes} GPS fixes{paused ? ` · location paused ${paused}×` : ""}</p>
      {vis.length === 0 ? (
        <div className="empty">No visits</div>
      ) : (
        <table className="data">
          <tbody>
            {vis.map((v) => (
              <tr key={v.start}>
                <td>Place {v.place}</td>
                <td>{range(v.start, v.end)}</td>
                <td className="r">{mins(v.end - v.start)}</td>
                <td><a href={`https://maps.apple.com/?ll=${v.lat},${v.lon}&q=Place%20${v.place}`} target="_blank" rel="noreferrer">Map ↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function WhoopList({ sleeps, workouts }: { sleeps: WhoopRecord[]; workouts: WhoopRecord[] }) {
  return (
    <div className="card">
      <h2>WHOOP</h2>
      {sleeps.length + workouts.length === 0 ? (
        <div className="empty">No sleep or workouts this day</div>
      ) : (
        <table className="data">
          <tbody>
            {sleeps.map((s) => (
              <tr key={String(s.id)}>
                <td>{s.nap ? "Nap" : "Sleep"}</td>
                <td>{range(t(s.start), t(s.end ?? undefined))}</td>
                <td className="r">{whoopSleepHours(s)?.toFixed(1) ?? "?"} h asleep</td>
                <td className="r">{num(s, "sleep_performance_percentage") ?? "?"}%</td>
              </tr>
            ))}
            {workouts.map((w) => (
              <tr key={String(w.id)}>
                <td>{w.sport_name ?? "Workout"}</td>
                <td>{range(t(w.start), t(w.end ?? undefined))}</td>
                <td className="r">strain {num(w, "strain")?.toFixed(1) ?? "?"}</td>
                <td className="r">{num(w, "average_heart_rate") ?? "?"} bpm</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RunsList({ runs, coverage, day }: { runs: Coverage["watch_runs"]; coverage: Coverage | null; day: number }) {
  const ymd = new Date(day + 12 * HOUR).toLocaleDateString("en-CA");
  const cov = coverage?.days.find((d) => d.day === ymd);
  return (
    <div className="card">
      <h2>What arrived from the phone</h2>
      <p className="small secondary">
        {cov
          ? `${cov.ios_total} lines: ` + Object.entries(cov.ios).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") +
            ` · Safari ${cov.safari}`
          : "No coverage for this day"}
        {coverage?.last_received.ios ? ` · last line ${fmtAgo(Date.parse(coverage.last_received.ios))}` : ""}
      </p>
      {runs.length > 0 && (
        <table className="data">
          <thead><tr><th>TT Watch run</th><th>From – to</th><th className="r">Time</th><th className="r">Lines</th><th>Ended</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run}>
                <td>{r.run}</td>
                <td>{range(t(r.first), t(r.last))}</td>
                <td className="r">{mins(t(r.last) - t(r.first))}</td>
                <td className="r">{r.lines}</td>
                <td>{r.ended ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** YYYY-MM-DD of a tracking day's start, in the browser's time zone. */
const localDate = (ms: number) => new Date(ms).toLocaleDateString("en-CA");

/** The day's story (newest of the midday, evening or on-demand ones), with a button to write one now. */
function StoryCard({ day, isToday }: { day: string; isToday: boolean }) {
  const [stories, setStories] = useState<DayStory[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let live = true;
    setStories(null);
    setShown(0);
    api.stories(day).then((r) => live && setStories(r.stories), (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [day]);
  const write = () => {
    setBusy(true);
    setError(null);
    api.stories(day, true).then(
      (r) => {
        setStories(r.stories);
        setShown(0);
      },
      (e: Error) => setError(e.message),
    ).finally(() => setBusy(false));
  };
  const story = stories?.[shown];
  return (
    <div className="card story">
      <div className="story-head">
        <h2>The story of the day</h2>
        <span className="spacer" style={{ flex: 1 }} />
        {stories && stories.length > 1 && (
          <select value={shown} onChange={(e) => setShown(Number(e.target.value))} aria-label="Which story">
            {stories.map((s, i) => (
              <option key={s.created} value={i}>{s.slot} · {fmtTime(Date.parse(s.created))}</option>
            ))}
          </select>
        )}
        <button className="btn" onClick={write} disabled={busy}>{busy ? "Writing…" : "Write it now"}</button>
      </div>
      {error && <div className="small error">{error}</div>}
      {!stories ? (
        <div className="empty">Loading…</div>
      ) : !story ? (
        <div className="empty">
          {isToday
            ? "Nothing yet: one is written 6 hours into the day, and the last once you're asleep (WHOOP's sleep, or 4 quiet hours overnight)."
            : "No story was written for this day."}
        </div>
      ) : (
        <>
          <Markdown text={story.text} />
          <div className="small muted">Written {fmtTime(Date.parse(story.created))} ({story.slot}) by {story.model ?? "?"}</div>
        </>
      )}
    </div>
  );
}

/** The little Markdown a story uses: ### headings, - bullets, paragraphs, **bold**. */
function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    if (bullets.length) blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    para = [];
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (/^#{1,4} /.test(line)) {
      flush();
      blocks.push(<h3 key={blocks.length}>{inline(line.replace(/^#+ /, ""))}</h3>);
    } else if (/^[-*] /.test(line)) {
      if (para.length) flush();
      bullets.push(line.slice(2));
    } else {
      if (bullets.length) flush();
      para.push(line);
    }
  }
  flush();
  return <div className="story-text">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}
