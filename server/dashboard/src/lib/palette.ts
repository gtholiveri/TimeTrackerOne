// The categorical palette (validated: CVD-safe adjacent pairs in both modes).
// Top-level categories take a slot each, in order; subcategories share their
// parent's hue. A 9th top-level category folds into gray.
export const PALETTE_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const PALETTE_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const SLOT_NAMES = ["Blue", "Orange", "Aqua", "Yellow", "Magenta", "Green", "Violet", "Red"];

/** The CSS color for a palette slot (null: uncategorized / folded). */
export const slotColor = (slot: number | null) => (slot === null ? "var(--cat-none)" : `var(--cat-${slot})`);

export function slotOf(color: unknown): number | null {
  if (typeof color !== "string") return null;
  const c = color.toLowerCase();
  const i = PALETTE_LIGHT.indexOf(c);
  return i >= 0 ? i : PALETTE_DARK.indexOf(c) >= 0 ? PALETTE_DARK.indexOf(c) : null;
}

export const RATING_COLOR = {
  productive: "var(--rate-good)",
  neutral: "var(--rate-neutral)",
  distracting: "var(--rate-bad)",
} as const;
