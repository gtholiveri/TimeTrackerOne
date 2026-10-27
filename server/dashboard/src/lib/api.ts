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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const iso = (t: number) => new Date(t).toISOString();

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
  labels: (blocks: LabelRequest[]) =>
    request<LabelAnswer>("/tt/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
    }),
};
