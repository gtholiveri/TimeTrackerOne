// Blocks: stretches of the day that were "about" one thing (writing in
// Overleaf, CAD in SolidWorks, a show on Disney+), built from the merged
// line by joining nearby segments of the same subject and absorbing short
// interruptions. Each block carries a heuristic label; the relay can replace
// it with a model-written one (see labels.ts).

import type { CSeg } from "./aggregate";
import type { Category } from "./categories";

/** One thing a block contained, with how long. Sorted longest first. */
export interface BlockItem {
  subject: string; // site for browser time, else the app (aggregate.subject)
  app: string;
  title: string; // the longest-running window / page title for this subject
  seconds: number;
  category: string; // "Work › Programming"
}

export interface Block {
  /** Stable while the block's start doesn't move, so labels survive refreshes. */
  id: string;
  start: number;
  end: number;
  segs: CSeg[];
  items: BlockItem[];
  /** The category with the most time in the block. */
  cat: Category;
  /** Heuristic label, used until (or instead of) a model-written one. */
  label: string;
}

export interface BlockOptions {
  /** Join same-subject pieces across gaps up to this long. */
  gapMs?: number;
  /** Absorb interruptions shorter than this into the surrounding block. */
  minMs?: number;
}

export function buildBlocks(_segs: CSeg[], _opts: BlockOptions = {}): Block[] {
  throw new Error("buildBlocks: not implemented yet");
}
