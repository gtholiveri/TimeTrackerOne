import { describe, expect, it } from "vitest";
import { lineTime, motionStretches, parseLine, visits, type Line } from "./fused";

const L = (s: string) => parseLine(`tt|src=ios|dev=Phone|${s}`) as Line;
const T = (hm: string) => lineTime(`2026-11-23 ${hm}:00.000-08:00`);

describe("parseLine", () => {
  it("reads key=value fields and skips non-tt lines", () => {
    expect(parseLine("tt|kind=motion|activity=walking")).toEqual({ kind: "motion", activity: "walking" });
    expect(parseLine("hello")).toBeNull();
    expect(lineTime("2026-11-23 10:00:00.000-08:00")).toBe(Date.parse("2026-11-23T18:00:00Z"));
  });
});

describe("motionStretches", () => {
  it("joins walking across short stationary flickers and drops stationary", () => {
    const lines = [
      L(`kind=motion|ts=2026-11-23 10:00:00.000-08:00|activity=walking`),
      L(`kind=motion|ts=2026-11-23 10:05:00.000-08:00|activity=stationary`),
      L(`kind=motion|ts=2026-11-23 10:06:00.000-08:00|activity=walking`),
      L(`kind=motion|ts=2026-11-23 10:10:00.000-08:00|activity=stationary`),
      L(`kind=motion|ts=2026-11-23 11:00:00.000-08:00|activity=cycling`),
    ];
    expect(motionStretches(lines, T("11:20"))).toEqual([
      { start: T("10:00"), end: T("10:10"), what: "walking" },
      { start: T("11:00"), end: T("11:20"), what: "cycling" },
    ]);
  });
});

describe("visits", () => {
  it("keeps the later report of a visit, clips to the day and names places", () => {
    const lines = [
      L(`kind=visit|ts=2026-11-23 09:00:00.000-08:00|arrive=2026-11-23 08:00:00.000-08:00|depart=4001-01-01 00:00:00.000-08:00|lat=34.02|lon=-118.28|acc=20`),
      L(`kind=visit|ts=2026-11-23 10:00:00.000-08:00|arrive=2026-11-23 08:00:00.000-08:00|depart=2026-11-23 10:00:00.000-08:00|lat=34.02|lon=-118.28|acc=20`),
      L(`kind=visit|ts=2026-11-23 12:00:00.000-08:00|arrive=2026-11-23 11:00:00.000-08:00|depart=4001-01-01 00:00:00.000-08:00|lat=34.05|lon=-118.25|acc=20`),
      L(`kind=visit|ts=2026-11-23 13:00:00.000-08:00|arrive=2026-11-22 20:00:00.000-08:00|depart=2026-11-23 07:00:00.000-08:00|lat=34.0201|lon=-118.2801|acc=20`),
    ];
    const v = visits(lines, T("04:00"), T("14:00"));
    expect(v.map((x) => [x.place, x.start, x.end, x.ongoing])).toEqual([
      ["A", T("04:00"), T("07:00"), false],
      ["A", T("08:00"), T("10:00"), false],
      ["B", T("11:00"), T("14:00"), true],
    ]);
  });
});
