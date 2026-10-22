// App-wide state: devices, settings (categories, attention rules, start of
// day), and hooks that load activity for a time range.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildSegs, discoverDevices, fetchRaw, type Device, type RawDevice, type Seg } from "./activity";
import { categorizeAll, type CSeg } from "./aggregate";
import { api, type TTState } from "./api";
import { ATTENTION_KEY, DEFAULT_ATTENTION, mergeAttention, parseAttention, type AttentionConfig } from "./attention";
import { AW_DEFAULT_CLASSES, CategorySet, forSaving, type ClassDef } from "./categories";
import { parseStartOfDay, type Range } from "./time";

interface AppState {
  devices: Device[];
  defs: ClassDef[];
  defsSaved: boolean;
  cats: CategorySet;
  attention: AttentionConfig;
  dayOffset: number;
  /** Saves to ActivityWatch and returns the defs as stored (hues written in). */
  saveDefs: (defs: ClassDef[]) => Promise<ClassDef[]>;
  saveAttention: (cfg: AttentionConfig) => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

type Boot =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; devices: Device[]; settings: Record<string, unknown> };

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (b: Boot) => ReactNode }) {
  const [boot, setBoot] = useState<Boot>({ status: "loading" });

  useEffect(() => {
    Promise.all([api.buckets(), api.settings()])
      .then(([buckets, settings]) => setBoot({ status: "ready", devices: discoverDevices(buckets), settings: settings ?? {} }))
      .catch((e: Error) => setBoot({ status: "error", error: e.message }));
  }, []);

  const settings = boot.status === "ready" ? boot.settings : null;
  const saved = settings && Array.isArray(settings.classes) && settings.classes.length > 0 ? (settings.classes as ClassDef[]) : null;
  const defs = saved ?? AW_DEFAULT_CLASSES;
  const cats = useMemo(() => new CategorySet(defs), [defs]);
  const attention = useMemo(() => parseAttention(settings?.[ATTENTION_KEY] ?? DEFAULT_ATTENTION), [settings]);

  const setSetting = useCallback(async (key: string, value: unknown) => {
    await api.saveSetting(key, value);
    setBoot((b) => (b.status === "ready" ? { ...b, settings: { ...b.settings, [key]: value } } : b));
  }, []);

  const value = useMemo<AppState | null>(
    () =>
      boot.status !== "ready"
        ? null
        : {
            devices: boot.devices,
            defs,
            defsSaved: saved !== null,
            cats,
            attention,
            dayOffset: parseStartOfDay(boot.settings.startOfDay),
            saveDefs: async (next) => {
              const stored = forSaving(next, new CategorySet(next));
              await setSetting("classes", stored);
              return stored;
            },
            saveAttention: (cfg) => setSetting(ATTENTION_KEY, cfg),
          },
    [boot, defs, saved, cats, attention, setSetting],
  );

  if (!value) return <>{fallback(boot)}</>;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export interface Lane {
  device: Device;
  segs: Seg[];
  raw: RawDevice;
}

export interface Activity {
  lanes: Lane[] | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  reload: () => void;
}

/** Activity per device for a range; refetched every `refreshMs` while the range
 *  includes now. The previous result stays up while a refetch runs. */
export function useActivity(range: Range, refreshMs = 60_000): Activity {
  const { devices } = useApp();
  const [state, setState] = useState<Omit<Activity, "reload">>({ lanes: null, loading: true, error: null, loadedAt: null });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fetchRaw(devices, range.start, range.end)
      .then((raws) => {
        if (id !== seq.current) return;
        const lanes = raws.map((raw) => ({ device: raw.device, raw, segs: buildSegs(raw, range.start, range.end) }));
        setState({ lanes, loading: false, error: null, loadedAt: Date.now() });
      })
      .catch((e: Error) => id === seq.current && setState((s) => ({ ...s, loading: false, error: e.message })));
  }, [devices, range.start, range.end, tick]);

  const live = range.end > Date.now() && range.start <= Date.now();
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), refreshMs);
    return () => clearInterval(t);
  }, [live, refreshMs]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

export interface Derived {
  lanes: { device: Device; segs: CSeg[] }[];
  merged: CSeg[];
}

/** Categorized lanes plus the merged attention line. */
export function useDerived(lanes: Lane[] | null, cats: CategorySet, cfg: AttentionConfig): Derived | null {
  return useMemo(() => {
    if (!lanes) return null;
    const cl = lanes.map((l) => ({ device: l.device, segs: categorizeAll(l.segs, cats) }));
    return { lanes: cl, merged: mergeAttention(cl.map((l) => l.segs), cfg) };
  }, [lanes, cats, cfg]);
}

/** The relay's live feed (the phone's current state), polled while visible. */
export function useLiveState(intervalMs = 15_000): TTState | null {
  const [state, setState] = useState<TTState | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      document.visibilityState === "visible" &&
      api.state(1).then((s) => alive && setState(s)).catch(() => undefined);
    load();
    const t = setInterval(load, intervalMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [intervalMs]);
  return state;
}

/** Re-render every `ms` (for "x minutes ago" and the live tail). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
