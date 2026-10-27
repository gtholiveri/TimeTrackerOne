// Model-written labels for blocks ("Writing in Overleaf"), from the relay's
// /tt/labels, which asks a free LLM API and caches the answers. Falls back to
// each block's heuristic label while loading or when the relay has no model.
//
// Labels are kept by a coarse content key (contentNorm, the same string the
// relay keys its cache by), in memory and in localStorage, so a live block
// that keeps growing, or a page reload, doesn't ask again.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LabelRequest } from "./api";
import type { Block, BlockItem } from "./blocks";

const DEBOUNCE_MS = 1500;
const MIN_MS = 5 * 60_000; // shorter blocks keep their heuristic label
const RETRY_MS = 10 * 60_000; // after the relay labeled nothing for a block
const MAX_ITEMS = 6;
const MAX_PER_REQUEST = 60;
const STORAGE_KEY = "tt.blockLabels.v1";
const MAX_STORED = 2000;

const titleNorm = (t: string) =>
  t.toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ").trim().slice(0, 40).trim();

/** What a block's label depends on: its main subjects in order (the top one,
 *  then any with at least 15% of the block, at most 3) and their titles,
 *  letters only. Same as the relay's labels.content_norm. */
export function contentNorm(items: BlockItem[]): string {
  const top = [...items].sort((a, b) => b.seconds - a.seconds).slice(0, MAX_ITEMS);
  const total = top.reduce((n, it) => n + it.seconds, 0) || 1;
  return top
    .slice(0, 3)
    .filter((it, i) => i === 0 || it.seconds / total >= 0.15)
    .map((it) => `${(it.subject || it.app).toLowerCase()}|${titleNorm(it.title)}`)
    .join("\n");
}

/** A short hash of contentNorm (two FNV-1a passes), for storage. */
export function contentKey(items: BlockItem[]): string {
  const s = contentNorm(items);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// ------------------------------------------------------------ the cache

const cache = new Map<string, string>(); // content key -> label
const inflight = new Set<string>();
const tried = new Map<string, number>(); // content key -> when the relay last had no label

try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  for (const [k, v] of Object.entries(stored)) if (typeof v === "string") cache.set(k, v);
} catch {
  // no storage (private window, tests): memory only
}

function save() {
  try {
    const entries = [...cache].slice(-MAX_STORED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // full or blocked: memory only
  }
}

const wanted = (b: Block, key: string) =>
  b.end - b.start >= MIN_MS &&
  b.items.length > 0 &&
  !cache.has(key) &&
  !inflight.has(key) &&
  Date.now() - (tried.get(key) ?? -Infinity) >= RETRY_MS;

/** Block id -> label. Contains every block passed in. */
export function useBlockLabels(blocks: Block[]): Map<string, string> {
  const keys = useMemo(() => blocks.map((b) => contentKey(b.items)), [blocks]);
  const [version, setVersion] = useState(0);
  const latest = useRef({ blocks, keys });
  latest.current = { blocks, keys };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Changes only when there is something new to ask, so refreshes that leave
  // the content alone don't restart the debounce.
  const pending = [...new Set(keys.filter((k, i) => wanted(blocks[i], k)))].join(",");

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      const { blocks, keys } = latest.current;
      const ask = new Map<string, LabelRequest>(); // content key -> request, one per key
      blocks.forEach((b, i) => {
        if (ask.size < MAX_PER_REQUEST && !ask.has(keys[i]) && wanted(b, keys[i])) {
          ask.set(keys[i], { id: keys[i], items: b.items.slice(0, MAX_ITEMS).map(toItem) });
        }
      });
      if (!ask.size) return;
      for (const k of ask.keys()) inflight.add(k);
      api
        .labels([...ask.values()])
        .then((res) => {
          for (const k of ask.keys()) {
            const label = res?.labels?.[k];
            if (typeof label === "string" && label) cache.set(k, label);
            else tried.set(k, Date.now());
          }
          save();
          if (mounted.current) setVersion((v) => v + 1);
        })
        .catch(() => {
          for (const k of ask.keys()) tried.set(k, Date.now());
        })
        .finally(() => {
          for (const k of ask.keys()) inflight.delete(k);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  return useMemo(
    () => new Map(blocks.map((b, i) => [b.id, cache.get(keys[i]) ?? b.label])),
    [blocks, keys, version], // version: the cache changed
  );
}

const toItem = (it: BlockItem) => ({
  subject: it.subject,
  app: it.app,
  title: it.title,
  seconds: Math.round(it.seconds),
  category: it.category,
});
