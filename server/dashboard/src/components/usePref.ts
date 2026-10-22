import { useState } from "react";

// Per-browser view preferences (a remembered toggle). Storage can be missing or
// blocked (private windows); the default is used then.
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`tt.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(`tt.${key}`, JSON.stringify(v));
    } catch {
      // not remembered this time
    }
  };
  return [value, set];
}
