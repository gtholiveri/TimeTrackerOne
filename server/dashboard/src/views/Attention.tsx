// The rules that merge the devices into one "you" line, with a preview of a
// day under the draft rules before saving them.

import { useMemo, useState } from "react";
import { ranked, sumBy } from "../lib/aggregate";
import { DEFAULT_ATTENTION, isBackground, type AttentionConfig } from "../lib/attention";
import { useActivity, useApp, useDerived, useNow } from "../lib/store";
import { addDays, dayStart, fmtDuration } from "../lib/time";
import { Timeline, visibleRange } from "../components/Timeline";

export function Attention() {
  const { attention, saveAttention, cats, dayOffset, devices } = useApp();
  const now = useNow(60_000);
  const [draft, setDraft] = useState<AttentionConfig>(attention);
  const [shift, setShift] = useState(0);
  const [newApp, setNewApp] = useState("");
  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle");
  const dirty = JSON.stringify(draft) !== JSON.stringify(attention);

  const today = dayStart(now, dayOffset);
  const range = useMemo(() => {
    const start = addDays(today, shift, dayOffset);
    return { start, end: addDays(start, 1, dayOffset) };
  }, [today, shift, dayOffset]);
  const act = useActivity(range);
  const derived = useDerived(act.lanes, cats, draft);
  const label = (h: string) => devices.find((d) => d.host === h)?.label ?? h;

  const phoneSegs = derived?.lanes.filter((l) => l.device.kind === "phone").flatMap((l) => l.segs) ?? [];
  const phoneApps = ranked(sumBy(phoneSegs.filter((s) => !s.home), (s) => s.app));
  const backgroundTime = phoneSegs.filter((s) => !s.home && isBackground(s.app, draft)).reduce((a, s) => a + (s.end - s.start) / 1000, 0);
  const merged = derived?.merged ?? [];
  const mergedTotal = merged.reduce((a, s) => a + (s.end - s.start) / 1000, 0);
  const byHost = [...sumBy(merged, (s) => s.host)].sort((a, b) => b[1] - a[1]);

  const addApp = (app: string) => {
    const a = app.trim();
    if (!a || isBackground(a, draft)) return;
    setDraft({ ...draft, backgroundApps: [...draft.backgroundApps, a] });
    setNewApp("");
  };
  const removeApp = (app: string) => setDraft({ ...draft, backgroundApps: draft.backgroundApps.filter((b) => b !== app) });

  const save = async () => {
    setSaving("saving");
    try {
      await saveAttention(draft);
      setSaving("idle");
    } catch {
      setSaving("error");
    }
  };

  const phoneFirst = draft.priority === "phone";
  return (
    <div className="stack">
      <div className="filters">
        <h1 style={{ fontSize: 22, margin: "0 8px 0 0" }}>Attention</h1>
        <span className="secondary">How phone and laptop merge into one line of what had your attention.</span>
      </div>

      <div className="cat-layout attn-layout">
        <div className="card">
          <h2>Rules, in order</h2>
          <ol style={{ margin: "0 0 16px", paddingLeft: 20, lineHeight: 1.6 }}>
            <li>A phone app on the <b>background list</b> never counts: it's on screen, but you aren't.</li>
            <li>
              When both are in use, the <b>{phoneFirst ? "phone" : "laptop"}</b> wins
              {phoneFirst ? ": picking it up means your attention moved." : ": phone checks at the desk count as laptop time."}
            </li>
            <li>The laptop counts while its AFK watcher says you're active (input in the last 3 minutes).</li>
            <li>The phone's <b>Home Screen</b> {draft.homeScreenCounts ? "counts when nothing else does." : "never counts."}</li>
          </ol>

          <div className="form-grid">
            <label>When both</label>
            <div className="seg-control" role="group" aria-label="Priority">
              <button aria-pressed={phoneFirst} onClick={() => setDraft({ ...draft, priority: "phone" })}>Phone wins</button>
              <button aria-pressed={!phoneFirst} onClick={() => setDraft({ ...draft, priority: "desktop" })}>Laptop wins</button>
            </div>

            <label>Home Screen</label>
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={draft.homeScreenCounts}
                onChange={(e) => setDraft({ ...draft, homeScreenCounts: e.target.checked })} />
              Counts as phone time
            </label>

            <label>Background apps</label>
            <div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {draft.backgroundApps.map((a) => (
                  <span key={a} className="chip">
                    {a}
                    <button onClick={() => removeApp(a)} aria-label={`Remove ${a}`}>×</button>
                  </span>
                ))}
                {!draft.backgroundApps.length && <span className="muted">None</span>}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input type="text" placeholder="App name, as the phone reports it" value={newApp}
                  onChange={(e) => setNewApp(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addApp(newApp)} style={{ flex: 1 }} />
                <button className="btn" onClick={() => addApp(newApp)}>Add</button>
              </div>
            </div>
          </div>
          <p className="muted small" style={{ marginTop: 16 }}>
            Saved in ActivityWatch's settings as <code>tt_attention</code>. Duration rules (say, an app on screen for over an
            hour stops counting) can come later.
          </p>
          <button className="btn" onClick={() => setDraft(DEFAULT_ATTENTION)}>Reset to defaults</button>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Preview</h2>
              <span className="spacer" />
              <div className="seg-control" role="group" aria-label="Day">
                {[0, -1, -2].map((d) => (
                  <button key={d} aria-pressed={shift === d} onClick={() => setShift(d)}>
                    {d === 0 ? "Today" : d === -1 ? "Yesterday" : "2 days ago"}
                  </button>
                ))}
              </div>
            </div>
            {derived ? (
              <>
                <Timeline range={visibleRange(range, derived.lanes.flatMap((l) => l.segs), shift === 0 ? now : null)}
                  now={shift === 0 ? now : undefined} deviceLabel={label}
                  lanes={[...derived.lanes.map((l) => ({ label: l.device.label, segs: l.segs })), { label: "You", segs: merged }]} />
                <p className="secondary" style={{ marginBottom: 0 }}>
                  <b>{fmtDuration(mergedTotal)}</b> of attention
                  {byHost.length > 0 && <> ({byHost.map(([h, s]) => `${label(h)} ${fmtDuration(s)}`).join(", ")})</>}
                  {backgroundTime > 0 && <>; {fmtDuration(backgroundTime)} of background phone apps left out</>}.
                </p>
              </>
            ) : (
              <div className="empty">{act.error ?? "Loading…"}</div>
            )}
          </div>

          <div className="card">
            <h2>Phone apps that day</h2>
            {!phoneApps.length ? (
              <div className="empty">No phone apps that day.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>App</th>
                    <th className="r">On screen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {phoneApps.map((r) => {
                    const bg = isBackground(r.key, draft);
                    return (
                      <tr key={r.key}>
                        <td>{r.key}</td>
                        <td className="r">{fmtDuration(r.seconds)}</td>
                        <td className="r">
                          <button className="btn" onClick={() => (bg ? removeApp(draft.backgroundApps.find((b) => b.toLowerCase() === r.key.toLowerCase())!) : addApp(r.key))}>
                            {bg ? "Counts as background ✓" : "Mark as background"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {(dirty || saving === "error") && (
        <div className="savebar">
          <span>{saving === "error" ? <span className="error">Saving failed. Try again?</span> : "Unsaved changes: the preview shows them already"}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => setDraft(attention)} disabled={saving === "saving"}>Discard</button>
          <button className="btn primary" onClick={save} disabled={saving === "saving"}>{saving === "saving" ? "Saving…" : "Save"}</button>
        </div>
      )}
    </div>
  );
}
