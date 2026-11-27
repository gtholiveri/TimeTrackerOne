// The relay's API, same origin as the page: ActivityWatch's REST API under
// /api/0/ (proxied by the relay), the relay's own live feed at /tt/state and
// its block labels at /tt/labels.
// The browser sends the saved sign-in by itself.

export interface AWEvent {
  id?: number;
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
}

export interface Bucket {
  id: string;
  type: string;
  client: string;
  hostname: string;
  last_updated?: string | null;
}

export interface TTInterval {
  start: string;
  end: string;
  seconds: number;
  state: "app" | "home" | "locked";
  app: string | null;
  confidence: string;
}

export interface TTDevice {
  host: string;
  current: TTInterval | null;
  safari_page: { url: string; title: string; end: string } | null;
  last_received: number | null;
  intervals: TTInterval[];
}

export interface TTState {
  now: string;
  devices: Record<string, TTDevice>;
}

/** A block as /tt/labels takes it: its top items, longest first. */
export interface LabelRequest {
  id: string;
  items: { subject: string; app: string; title: string; seconds: number; category: string }[];
}

export interface LabelAnswer {
  /** Block id -> label, for the blocks a model labeled (or the cache had). */
  labels: Record<string, string>;
  model: string | null;
}

/** A categorized stretch from /tt/activity (the relay runs the dashboard's pipeline). */
export interface ActivitySeg {
  start: string;
  end: string;
  seconds: number;
  device: string;
  kind: "phone" | "desktop";
  app: string;
  title: string;
  domain: string;
  category: string;
  rating: string;
}

export interface ActivityAnswer {
  devices: { host: string; kind: string }[];
  segments: ActivitySeg[];
}

/** A stretch spent in Claude, from /tt/claude/blocks. */
export interface ClaudeBlock {
  start: string;
  end: string;
  seconds: number;
  devices: Record<string, number>;
  where: Record<string, number>;
  sessions: { title: string; surface: string; you: number; claude: number }[];
  typed: { ts: string; session: string; text: string }[];
  /** "project: goal", or the older free-form label. */
  label: string | null;
  project?: string | null;
  goal?: string | null;
  summary: string | null;
  kind: string | null;
  verdict?: "productive" | "mixed" | "unproductive" | null;
}

/** The story of a day, from /tt/story: Markdown written at about 1 PM and 9 PM. */
export interface DayStory {
  slot: string;
  created: string;
  model: string | null;
  text: string;
}

export interface ClaudeBlocks {
  blocks: ClaudeBlock[];
  label_notes?: string[];
}

export interface WatchRun {
  run: string;
  dev: string;
  first: string;
  last: string;
  lines: number;
  ended: boolean;
  hours: number;
}

export interface CoverageDay {
  day: string;
  ios: Record<string, number>;
  ios_total: number;
  safari: number;
  devices: string[];
  newest: string;
}

export interface Coverage {
  last_received: Record<string, string>;
  days: CoverageDay[];
  watch_runs: WatchRun[];
}

/** One WHOOP record, whole, as WHOOP sends it, plus the kind. */
export interface WhoopRecord {
  kind: string;
  start?: string;
  end?: string | null;
  created_at?: string;
  sport_name?: string;
  nap?: boolean;
  score?: Record<string, unknown> | null;
  [k: string]: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const iso = (t: number) => new Date(t).toISOString();
const enc = (t: number) => encodeURIComponent(iso(t));

export const api = {
  buckets: () => request<Record<string, Bucket>>("/api/0/buckets/"),
  events: (bucket: string, start: number, end: number) =>
    request<AWEvent[]>(`/api/0/buckets/${encodeURIComponent(bucket)}/events?start=${iso(start)}&end=${iso(end)}`),
  settings: () => request<Record<string, unknown>>("/api/0/settings"),
  saveSetting: (key: string, value: unknown) =>
    request<unknown>(`/api/0/settings/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }),
  state: (hours = 1) => request<TTState>(`/tt/state?hours=${hours}`),
  activity: (start: number, end: number, view: "attention" | "devices" = "devices") =>
    request<ActivityAnswer>(`/tt/activity?start=${enc(start)}&end=${enc(end)}&view=${view}`),
  stories: (day: string, refresh = false) =>
    request<{ day: string; stories: DayStory[] }>(`/tt/story?day=${day}${refresh ? "&refresh=1" : ""}`),
  claudeBlocks: (start: number, end: number) =>
    request<ClaudeBlocks>(`/tt/claude/blocks?start=${enc(start)}&end=${enc(end)}`),
  /** Raw phone lines, "tt|key=value|..." one per line. */
  lines: async (start: number, end: number, kinds: string[]) => {
    const res = await fetch(`/tt/lines?source=ios&start=${enc(start)}&end=${enc(end)}&kinds=${kinds.join(",")}`,
      { credentials: "same-origin" });
    if (!res.ok) throw new Error(`GET /tt/lines failed: ${res.status} ${res.statusText}`);
    return (await res.text()).split("\n").filter(Boolean);
  },
  whoop: (kind: string, days: number) => request<WhoopRecord[]>(`/tt/whoop?kind=${kind}&days=${days}`),
  coverage: (days: number) => request<Coverage>(`/tt/coverage?days=${days}`),
  labels: (blocks: LabelRequest[]) =>
    request<LabelAnswer>("/tt/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
    }),
};
