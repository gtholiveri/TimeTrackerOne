// Edit categories with a live preview. Changes stay in a draft until saved;
// saving writes ActivityWatch's "classes" setting, which its own web UI uses too.

import { useMemo, useState } from "react";
import type { Seg } from "../lib/activity";
import { subject } from "../lib/aggregate";
import {
  CategorySet, RATING_SCORE, UNCATEGORIZED, escapeRegex, keyOf, withAlternative,
  type Category, type ClassDef, type Rating, type Rule,
} from "../lib/categories";
import { PALETTE_LIGHT, SLOT_NAMES, slotColor } from "../lib/palette";
import { useActivity, useApp, useNow } from "../lib/store";
import { addDays, dayStart, fmtDuration } from "../lib/time";
import { usePref } from "../components/usePref";

type PreviewRange = "1d" | "7d" | "30d";

// ------------------------------------------------------------------ draft edits

const startsWith = (name: string[], prefix: string[]) => prefix.every((p, i) => name[i] === p);

function patchDef(defs: ClassDef[], name: string[], patch: (d: ClassDef) => ClassDef): ClassDef[] {
  const key = keyOf(name);
  const i = defs.findIndex((d) => keyOf(d.name) === key);
  if (i >= 0) return defs.map((d, j) => (j === i ? patch(d) : d));
  // A parent that only existed through its subcategories gets a def of its own.
  const at = defs.findIndex((d) => startsWith(d.name, name));
  const created = patch({ name, rule: { type: "none" } });
  return at >= 0 ? [...defs.slice(0, at), created, ...defs.slice(at)] : [...defs, created];
}

function moveTree(defs: ClassDef[], from: string[], to: string[]): ClassDef[] {
  return defs.map((d) => (startsWith(d.name, from) ? { ...d, name: [...to, ...d.name.slice(from.length)] } : d));
}

const removeTree = (defs: ClassDef[], name: string[]) => defs.filter((d) => !startsWith(d.name, name));

function uniqueLeaf(set: CategorySet, parent: string[], base: string): string {
  let leaf = base;
  for (let n = 2; set.byKey.has(keyOf([...parent, leaf])); n++) leaf = `${base} ${n}`;
  return leaf;
}

function addCategory(defs: ClassDef[], set: CategorySet, parent: string[], base: string, rule: Rule): [ClassDef[], string[]] {
  const name = [...parent, uniqueLeaf(set, parent, base)];
  // New categories go before "Uncategorized", which stays last.
  const unc = defs.findIndex((d) => keyOf(d.name) === UNCATEGORIZED);
  const def: ClassDef = { name, rule };
  return [unc >= 0 ? [...defs.slice(0, unc), def, ...defs.slice(unc)] : [...defs, def], name];
}

const literalFor = (subj: string) => subj.replace(/\.exe$/i, "");

// ------------------------------------------------------------------ view

export function Categories() {
  const { defs, defsSaved, saveDefs, dayOffset } = useApp();
  const now = useNow(300_000);
  const [draft, setDraft] = useState<ClassDef[]>(defs);
  const [selected, setSelected] = useState<string>(defs[0] ? keyOf(defs[0].name) : UNCATEGORIZED);
  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle");
  const [rangeKey, setRangeKey] = usePref<PreviewRange>("cats.range", "7d");
  const set = useMemo(() => new CategorySet(draft), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(defs);

  const today = dayStart(now, dayOffset);
  const range = useMemo(
    () => ({ start: addDays(today, rangeKey === "1d" ? 0 : rangeKey === "7d" ? -6 : -29, dayOffset), end: addDays(today, 1, dayOffset) }),
    [today, rangeKey, dayOffset],
  );
  const act = useActivity(range, 300_000);
  // Every device's own time: categories apply to all of it, merged or not.
  const segs = useMemo(() => act.lanes?.flatMap((l) => l.segs) ?? [], [act.lanes]);

  const own = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of segs) {
      const k = set.categorize(s).key;
      m.set(k, (m.get(k) ?? 0) + (s.end - s.start) / 1000);
    }
    return m;
  }, [segs, set]);
  const subtree = (c: Category) => {
    let sec = 0;
    for (const [k, v] of own) if (k === c.key || k.startsWith(c.key + " > ")) sec += v;
    return sec;
  };

  const cat = set.byKey.get(selected) ?? set.uncategorized;
  const edit = (patch: (d: ClassDef) => ClassDef) => setDraft(patchDef(draft, cat.name, patch));

  const save = async () => {
    setSaving("saving");
    try {
      setDraft(await saveDefs(draft));
      setSaving("idle");
    } catch {
      setSaving("error");
    }
  };

  return (
    <div className="stack">
      <div className="filters">
        <h1 style={{ fontSize: 22, margin: "0 8px 0 0" }}>Categories</h1>
        <span className="muted">Preview over</span>
        <div className="seg-control" role="group" aria-label="Preview range">
          {(["1d", "7d", "30d"] as PreviewRange[]).map((k) => (
            <button key={k} aria-pressed={rangeKey === k} onClick={() => setRangeKey(k)}>
              {k === "1d" ? "Today" : k === "7d" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
        {act.loading && <span className="muted small">Loading…</span>}
        {!defsSaved && !dirty && (
          <span className="muted small">These are ActivityWatch's starter categories; nothing has been saved yet.</span>
        )}
      </div>

      <div className="cat-layout">
        <div className="card">
          <div className="card-head">
            <h2>All categories</h2>
            <span className="spacer" />
            <button className="btn" onClick={() => {
              const [next, name] = addCategory(draft, set, [], "New category", { type: "regex", regex: "", ignore_case: true });
              setDraft(next);
              setSelected(keyOf(name));
            }}>+ Category</button>
          </div>
          <div role="listbox" aria-label="Categories">
            {set.list.map((c) => (
              <div key={c.key} className="tree-row" role="option" aria-selected={c.key === cat.key} tabIndex={0} aria-label={c.key}
                style={{ paddingLeft: 8 + c.depth * 18 }} onClick={() => setSelected(c.key)}
                onKeyDown={(e) => e.key === "Enter" && setSelected(c.key)}>
                <span className="swatch" style={{ background: slotColor(c.slot) }} />
                <span className="name">{c.leaf}</span>
                {c.error && <span className="badge distracting" title={c.error}>bad rule</span>}
                {typeof c.def?.data?.score === "number" && c.rating !== "neutral" && <span className={`badge ${c.rating}`}>{c.rating}</span>}
                <span className="num muted small">{subtree(c) ? fmtDuration(subtree(c)) : ""}</span>
              </div>
            ))}
          </div>
        </div>

        {cat.key === UNCATEGORIZED ? (
          <Triage segs={segs} set={set} draft={draft} total={own.get(UNCATEGORIZED) ?? 0}
            onDraft={setDraft} onSelect={setSelected} />
        ) : (
          <div className="stack">
            <Editor cat={cat} set={set} edit={edit}
              onRename={(to) => { setDraft(moveTree(draft, cat.name, to)); setSelected(keyOf(to)); }}
              onAddChild={() => {
                const [next, name] = addCategory(draft, set, cat.name, "New subcategory", { type: "regex", regex: "", ignore_case: true });
                setDraft(next);
                setSelected(keyOf(name));
              }}
              onDelete={() => {
                if (!confirm(`Delete "${cat.key}"${set.list.some((c) => c.parentKey === cat.key) ? " and its subcategories" : ""}? (Not saved until you press Save.)`)) return;
                setDraft(removeTree(draft, cat.name));
                setSelected(cat.parentKey ?? UNCATEGORIZED);
              }} />
            <Preview cat={cat} set={set} segs={segs} />
          </div>
        )}
      </div>

      {(dirty || saving === "error") && (
        <div className="savebar">
          <span>{saving === "error" ? <span className="error">Saving failed. Try again?</span> : "Unsaved changes"}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => setDraft(defs)} disabled={saving === "saving"}>Discard</button>
          <button className="btn primary" onClick={save} disabled={saving === "saving"}>
            {saving === "saving" ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editor

function Editor({ cat, set, edit, onRename, onAddChild, onDelete }: {
  cat: Category;
  set: CategorySet;
  edit: (patch: (d: ClassDef) => ClassDef) => void;
  onRename: (to: string[]) => void;
  onAddChild: () => void;
  onDelete: () => void;
}) {
  const [leaf, setLeaf] = useState(cat.leaf);
  const [shownFor, setShownFor] = useState(cat.key);
  if (shownFor !== cat.key) {
    setShownFor(cat.key);
    setLeaf(cat.leaf);
  }
  const parent = cat.name.slice(0, -1);
  const rule = cat.def?.rule ?? { type: "none" as const };
  const ownScore = cat.def?.data?.score;
  const ownRating: Rating | "inherit" =
    typeof ownScore === "number" ? (ownScore > 0 ? "productive" : ownScore < 0 ? "distracting" : "neutral") : cat.depth ? "inherit" : "neutral";
  const parents = set.list.filter((c) => c.key !== UNCATEGORIZED && c.key !== cat.key && !c.key.startsWith(cat.key + " > "));

  const commitLeaf = () => {
    const name = leaf.trim();
    if (!name || name === cat.leaf || name.includes(">")) return setLeaf(cat.leaf);
    if (set.byKey.has(keyOf([...parent, name]))) return setLeaf(cat.leaf);
    onRename([...parent, name]);
  };
  const setRating = (r: Rating | "inherit") =>
    edit((d) => {
      const data = { ...d.data };
      if (r === "inherit" || (r === "neutral" && cat.depth === 0)) delete data.score;
      else data.score = RATING_SCORE[r];
      return { ...d, data };
    });

  return (
    <div className="card">
      <div className="card-head">
        <span className="swatch" style={{ background: slotColor(cat.slot), width: 14, height: 14 }} />
        <h2 style={{ fontSize: 16, color: "var(--ink)" }}>{cat.name.join(" › ")}</h2>
        <span className="spacer" />
        <button className="btn" onClick={onAddChild}>+ Subcategory</button>
        <button className="btn danger" onClick={onDelete}>Delete</button>
      </div>
      <div className="form-grid">
        <label htmlFor="cat-name">Name</label>
        <input id="cat-name" type="text" value={leaf} onChange={(e) => setLeaf(e.target.value)} onBlur={commitLeaf}
          onKeyDown={(e) => e.key === "Enter" && commitLeaf()} />

        <label htmlFor="cat-parent">Inside</label>
        <select id="cat-parent" value={keyOf(parent)} onChange={(e) => {
          const to = e.target.value ? [...set.byKey.get(e.target.value)!.name, cat.leaf] : [cat.leaf];
          if (!set.byKey.has(keyOf(to))) onRename(to);
        }}>
          <option value="">(top level)</option>
          {parents.map((p) => <option key={p.key} value={p.key}>{" ".repeat(p.depth) + p.leaf}</option>)}
        </select>

        <label htmlFor="cat-rule">Rule</label>
        <div>
          <input id="cat-rule" type="text" className="mono" style={{ width: "100%" }} placeholder="e.g. YouTube|Netflix|reddit\.com"
            value={rule.type === "regex" ? rule.regex ?? "" : ""}
            onChange={(e) => edit((d) => ({ ...d, rule: e.target.value ? { ...d.rule, type: "regex", regex: e.target.value } : { type: "none" } }))} />
          <div className="small" style={{ marginTop: 4 }}>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--ink-2)" }}>
              <input type="checkbox" checked={!!rule.ignore_case}
                onChange={(e) => edit((d) => ({ ...d, rule: { ...d.rule, ignore_case: e.target.checked } }))} />
              Ignore case
            </label>
            <span className="muted"> · A regular expression, tested against the app, window or page title, and URL. Separate alternatives with |.</span>
          </div>
          {cat.error && <div className="error small">{cat.error}</div>}
        </div>

        <label>Color</label>
        {cat.depth === 0 ? (
          <div className="slot-picker" role="group" aria-label="Color">
            {PALETTE_LIGHT.map((hex, i) => (
              <button key={hex} aria-pressed={cat.slot === i} title={SLOT_NAMES[i]} aria-label={SLOT_NAMES[i]}
                style={{ background: slotColor(i) }}
                onClick={() => edit((d) => ({ ...d, data: { ...d.data, color: hex } }))} />
            ))}
          </div>
        ) : (
          <span className="muted">Uses {cat.name[0]}'s color, so a family reads as one.</span>
        )}

        <label>Rating</label>
        <div className="seg-control" role="group" aria-label="Rating">
          {(["productive", "neutral", "distracting"] as Rating[]).map((r) => (
            <button key={r} aria-pressed={ownRating === r} onClick={() => setRating(r)}>{r[0].toUpperCase() + r.slice(1)}</button>
          ))}
          {cat.depth > 0 && (
            <button aria-pressed={ownRating === "inherit"} onClick={() => setRating("inherit")}>
              Same as {cat.name[cat.depth - 1]}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ preview

function Preview({ cat, set, segs }: { cat: Category; set: CategorySet; segs: Seg[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { seconds: number; here: number; elsewhere: Map<string, number>; title: string }>();
    const matches = (s: Seg) => cat.matcher && [s.app, s.title, s.url ?? ""].some((f) => f && cat.matcher!.test(f));
    for (const s of segs) {
      const assigned = set.categorize(s);
      const inTree = assigned.key === cat.key || assigned.key.startsWith(cat.key + " > ");
      if (!matches(s) && !inTree) continue;
      const k = subject(s);
      const r = m.get(k) ?? { seconds: 0, here: 0, elsewhere: new Map(), title: s.title };
      const sec = (s.end - s.start) / 1000;
      r.seconds += sec;
      if (inTree) r.here += sec;
      else r.elsewhere.set(assigned.key, (r.elsewhere.get(assigned.key) ?? 0) + sec);
      m.set(k, r);
    }
    return [...m].sort((a, b) => b[1].seconds - a[1].seconds);
  }, [cat, set, segs]);
  const total = rows.reduce((a, [, r]) => a + r.here, 0);

  return (
    <div className="card">
      <h2>What lands here · {fmtDuration(total)}</h2>
      {!rows.length ? (
        <div className="empty">{cat.matcher ? "Nothing in this range matches the rule." : "No rule yet: type one above, or add from Uncategorized."}</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>App / site</th>
                <th className="r">Here</th>
                <th>Example title</th>
                <th>Matches, but goes to</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 30).map(([k, r]) => (
                <tr key={k}>
                  <td className="clip" style={{ maxWidth: 160 }}>{k.replace(/\.exe$/i, "")}</td>
                  <td className="r">{r.here ? fmtDuration(r.here) : "–"}</td>
                  <td className="clip secondary" style={{ maxWidth: 220 }} title={r.title}>{r.title}</td>
                  <td className="clip muted" style={{ maxWidth: 200 }}>
                    {[...r.elsewhere].map(([key, sec]) => `${key} (${fmtDuration(sec)})`).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ uncategorized

function Triage({ segs, set, draft, total, onDraft, onSelect }: {
  segs: Seg[];
  set: CategorySet;
  draft: ClassDef[];
  total: number;
  onDraft: (d: ClassDef[]) => void;
  onSelect: (key: string) => void;
}) {
  const [limit, setLimit] = useState(40);
  const rows = useMemo(() => {
    const m = new Map<string, { seconds: number; titles: Map<string, number> }>();
    for (const s of segs) {
      if (set.categorize(s).key !== UNCATEGORIZED) continue;
      const k = subject(s);
      const r = m.get(k) ?? { seconds: 0, titles: new Map() };
      const sec = (s.end - s.start) / 1000;
      r.seconds += sec;
      if (s.title) r.titles.set(s.title, (r.titles.get(s.title) ?? 0) + sec);
      m.set(k, r);
    }
    return [...m].sort((a, b) => b[1].seconds - a[1].seconds);
  }, [segs, set]);
  const targets = set.list.filter((c) => c.key !== UNCATEGORIZED);

  const addTo = (subj: string, key: string) => {
    const target = set.byKey.get(key);
    if (!target) return;
    onDraft(patchDef(draft, target.name, (d) => ({ ...d, rule: withAlternative(d.rule, literalFor(subj)) })));
  };
  const newCategory = (subj: string) => {
    const [next, name] = addCategory(draft, set, [], literalFor(subj), { type: "regex", regex: escapeRegex(literalFor(subj)), ignore_case: true });
    onDraft(next);
    onSelect(keyOf(name));
  };

  return (
    <div className="card">
      <h2>Uncategorized · {fmtDuration(total)}</h2>
      <p className="secondary small" style={{ marginTop: -4 }}>
        Biggest first. Add one to a category to extend that category's rule with its name, or start a new category from it.
      </p>
      {!rows.length ? (
        <div className="empty">Everything in this range has a category.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>App / site</th>
                <th>Top titles</th>
                <th className="r">Time</th>
                <th>Put it in</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map(([k, r]) => (
                <tr key={k}>
                  <td className="clip" style={{ maxWidth: 160 }}>{k.replace(/\.exe$/i, "")}</td>
                  <td className="clip secondary" style={{ maxWidth: 220 }}>
                    {[...r.titles].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t).join(" · ")}
                  </td>
                  <td className="r">{fmtDuration(r.seconds)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <select value="" style={{ width: 104 }} onChange={(e) => e.target.value && addTo(k, e.target.value)}
                      aria-label={`Add ${k} to a category`}>
                      <option value="">Add to…</option>
                      {targets.map((c) => <option key={c.key} value={c.key}>{" ".repeat(c.depth) + c.leaf}</option>)}
                    </select>{" "}
                    <button className="btn" onClick={() => newCategory(k)}>New</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <button className="btn" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 60)}>
              Show more ({rows.length - limit} left)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
