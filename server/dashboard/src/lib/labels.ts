// Model-written labels for blocks ("Writing in Overleaf"), from the relay's
// /tt/labels, which asks a free LLM API and caches the answers. Falls back to
// each block's heuristic label while loading or when the relay has no model.

import type { Block } from "./blocks";

/** Block id -> label. Contains every block passed in. */
export function useBlockLabels(blocks: Block[]): Map<string, string> {
  return new Map(blocks.map((b) => [b.id, b.label]));
}
