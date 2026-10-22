// Days, ranges and formatting. All times are epoch milliseconds in the browser's
// time zone. A "day" starts at ActivityWatch's startOfDay (04:00 by default), so
// a late night counts toward the day it started.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface Range {
  start: number;
  end: number;
}

/** Minutes after midnight that a day starts, from "HH:MM". */
export function parseStartOfDay(value: unknown): number {
  const m = typeof value === "string" ? value.match(/^(\d{1,2}):(\d{2})$/) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : 4 * 60;
}

/** Start of the day containing `t`, `offsetMin` minutes after local midnight. */
export function dayStart(t: number, offsetMin: number): number {
  const d = new Date(t - offsetMin * MINUTE);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offsetMin * MINUTE;
}

/** The day `n` days after the one starting at `start` (DST-safe). */
export function addDays(start: number, n: number, offsetMin: number): number {
  const d = new Date(start - offsetMin * MINUTE);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offsetMin * MINUTE;
}

export function dayRange(t: number, offsetMin: number): Range {
  const start = dayStart(t, offsetMin);
  return { start, end: addDays(start, 1, offsetMin) };
}

/** The starts of every day overlapping the range. */
export function daysIn(range: Range, offsetMin: number): number[] {
  const out: number[] = [];
  for (let d = dayStart(range.start, offsetMin); d < range.end; d = addDays(d, 1, offsetMin)) out.push(d);
  return out;
}

export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "3.4h" style, for axis ticks. */
export function fmtHours(seconds: number): string {
  const h = seconds / 3600;
  return h === 0 ? "0" : `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "numeric", day: "numeric" });

export const fmtTime = (t: number) => timeFmt.format(t);
export const fmtHour = (t: number) => hourFmt.format(t);
export const fmtDay = (t: number) => dayFmt.format(t);
export const fmtShortDay = (t: number) => shortDayFmt.format(t);

export function fmtAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  return `${fmtDuration(s)} ago`;
}
