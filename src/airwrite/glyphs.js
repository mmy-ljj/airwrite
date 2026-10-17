/**
 * Built-in air-writing glyph library.
 *
 * Each entry is `"KEY": [ stroke, stroke, ... ]` where a stroke is a polyline of
 * `[x, y]` pairs in a normalized box: x 0..1 left→right, y 0..1 top→bottom of the
 * character's own bounding box. Shapes are stored as *skeleton* polylines (the
 * path a person's fingertip would trace), not outlines, because the recognizer
 * matches fingertip trajectories.
 *
 * Notes on style:
 *   - Straight-lined capitals (E, T, H, ...) work well because they need few
 *     inflections; curves are approximated with a handful of points, which is
 *     exactly how people draw in the air.
 *   - Digits 0-9 are stored once each; '8' and '9' additionally have curvy
 *     variants under '8c'/'9c' (see CURVY) which train the matcher. The UI never
 *     shows the `c` variants.
 *
 * Invariants this table must keep (both are load-bearing):
 *   1. every value is a point set — `[[[x, y], ...], ...]`, see isPointSet();
 *   2. every glyph has a non-zero bounding box on both axes, because the
 *      matcher normalizes into the glyph's own bbox and a flat glyph divides by
 *      zero. Do not add a perfectly horizontal or vertical glyph.
 *
 * Adding your own glyph is a first-class feature: draw it in the app and press
 * "存为模板" (save as template). Those end up in localStorage, not here.
 */

export const STROKES = {
  // ---------------------------------------------------------------- digits ---
  // '0' is deliberately *narrower* than 'O' (aspect 0.64 vs 0.79): the two are
  // otherwise the same ring, and a nearest-neighbour matcher needs some
  // measurable difference between them.
  '0': [
    [[0.50, 0.03], [0.32, 0.08], [0.21, 0.24], [0.17, 0.45], [0.18, 0.64], [0.24, 0.83], [0.37, 0.95], [0.52, 0.97], [0.66, 0.90], [0.77, 0.74], [0.81, 0.51], [0.80, 0.31], [0.74, 0.15], [0.61, 0.05], [0.50, 0.03]],
  ],
  '1': [
    [[0.22, 0.20], [0.45, 0.04], [0.45, 0.52], [0.45, 0.96]],
  ],
  '2': [
    [[0.16, 0.20], [0.25, 0.08], [0.43, 0.03], [0.61, 0.06], [0.73, 0.18], [0.72, 0.33], [0.59, 0.48], [0.41, 0.62], [0.22, 0.76], [0.12, 0.92], [0.14, 0.96], [0.44, 0.96], [0.68, 0.97], [0.88, 0.97]],
  ],
  '3': [
    [[0.14, 0.08], [0.40, 0.03], [0.63, 0.05], [0.76, 0.16], [0.73, 0.30], [0.57, 0.42], [0.42, 0.47], [0.58, 0.50], [0.75, 0.58], [0.84, 0.72], [0.77, 0.87], [0.58, 0.96], [0.34, 0.96], [0.14, 0.90]],
  ],
  '4': [
    [[0.68, 0.04], [0.66, 0.34], [0.64, 0.58], [0.63, 0.96]],
    [[0.68, 0.04], [0.50, 0.24], [0.32, 0.44], [0.12, 0.66], [0.06, 0.75], [0.34, 0.74], [0.58, 0.74], [0.86, 0.74]],
  ],
  '5': [
    [[0.76, 0.06], [0.48, 0.06], [0.30, 0.06], [0.24, 0.30], [0.22, 0.45], [0.38, 0.42], [0.60, 0.45], [0.77, 0.58], [0.82, 0.74], [0.72, 0.89], [0.50, 0.97], [0.27, 0.94], [0.14, 0.85]],
  ],
  '6': [
    [[0.70, 0.06], [0.50, 0.11], [0.36, 0.24], [0.26, 0.43], [0.20, 0.64], [0.21, 0.81], [0.32, 0.93], [0.52, 0.95], [0.70, 0.87], [0.77, 0.72], [0.70, 0.57], [0.52, 0.50], [0.33, 0.52], [0.22, 0.60]],
  ],
  '7': [
    [[0.12, 0.06], [0.42, 0.04], [0.68, 0.04], [0.88, 0.04], [0.72, 0.28], [0.58, 0.52], [0.50, 0.74], [0.46, 0.96]],
  ],
  '8': [
    [[0.43, 0.46], [0.29, 0.37], [0.25, 0.23], [0.35, 0.09], [0.55, 0.04], [0.73, 0.11], [0.76, 0.25], [0.64, 0.38], [0.43, 0.46], [0.28, 0.58], [0.22, 0.74], [0.30, 0.89], [0.49, 0.96], [0.69, 0.91], [0.79, 0.76], [0.72, 0.60], [0.56, 0.49], [0.43, 0.46]],
  ],
  '9': [
    [[0.72, 0.33], [0.63, 0.44], [0.45, 0.50], [0.29, 0.44], [0.22, 0.29], [0.28, 0.14], [0.44, 0.05], [0.63, 0.07], [0.75, 0.19], [0.79, 0.38], [0.76, 0.60], [0.67, 0.78], [0.52, 0.92], [0.34, 0.97]],
  ],

  // ------------------------------------------------------------ letters ---
  A: [
    [[0.08, 0.96], [0.30, 0.52], [0.50, 0.06], [0.63, 0.34], [0.74, 0.63], [0.86, 0.96]],
    [[0.27, 0.66], [0.50, 0.64], [0.69, 0.64]],
  ],
  B: [
    [[0.24, 0.05], [0.24, 0.96]],
    [[0.24, 0.06], [0.54, 0.05], [0.70, 0.14], [0.70, 0.30], [0.55, 0.42], [0.29, 0.47], [0.57, 0.50], [0.76, 0.62], [0.78, 0.80], [0.64, 0.93], [0.38, 0.96], [0.24, 0.96]],
  ],
  C: [
    [[0.86, 0.22], [0.68, 0.08], [0.45, 0.04], [0.25, 0.15], [0.13, 0.36], [0.11, 0.61], [0.20, 0.83], [0.40, 0.95], [0.63, 0.95], [0.83, 0.84]],
  ],
  D: [
    [[0.24, 0.05], [0.24, 0.96]],
    [[0.24, 0.06], [0.50, 0.05], [0.70, 0.18], [0.79, 0.40], [0.79, 0.64], [0.68, 0.86], [0.46, 0.96], [0.24, 0.96]],
  ],
  E: [
    [[0.80, 0.06], [0.24, 0.06], [0.24, 0.51], [0.24, 0.96], [0.80, 0.96]],
    [[0.24, 0.51], [0.63, 0.51]],
  ],
  F: [
    [[0.80, 0.06], [0.24, 0.06], [0.24, 0.51], [0.24, 0.96]],
    [[0.24, 0.51], [0.63, 0.51]],
  ],
  G: [
    [[0.86, 0.22], [0.68, 0.08], [0.45, 0.04], [0.25, 0.15], [0.13, 0.36], [0.11, 0.61], [0.20, 0.83], [0.40, 0.95], [0.63, 0.95], [0.83, 0.85], [0.85, 0.60], [0.62, 0.58]],
  ],
  H: [
    [[0.22, 0.05], [0.22, 0.51], [0.22, 0.96]],
    [[0.76, 0.05], [0.76, 0.51], [0.76, 0.96]],
    [[0.22, 0.51], [0.50, 0.50], [0.76, 0.51]],
  ],
  I: [
    [[0.25, 0.06], [0.73, 0.06]],
    [[0.49, 0.06], [0.49, 0.51], [0.49, 0.96]],
    [[0.25, 0.96], [0.73, 0.96]],
  ],
  J: [
    [[0.55, 0.06], [0.57, 0.45], [0.55, 0.76], [0.44, 0.91], [0.26, 0.91], [0.14, 0.78], [0.13, 0.62]],
  ],
  K: [
    [[0.22, 0.05], [0.22, 0.51], [0.22, 0.96]],
    [[0.80, 0.06], [0.56, 0.33], [0.32, 0.56], [0.62, 0.68], [0.82, 0.96], [0.68, 0.82]],
  ],
  L: [
    [[0.26, 0.05], [0.26, 0.51], [0.26, 0.96], [0.78, 0.96]],
  ],
  M: [
    [[0.10, 0.96], [0.21, 0.48], [0.31, 0.05], [0.50, 0.44], [0.68, 0.84], [0.79, 0.42], [0.90, 0.05], [0.90, 0.50], [0.90, 0.96]],
  ],
  N: [
    [[0.16, 0.96], [0.21, 0.50], [0.26, 0.05], [0.68, 0.91], [0.73, 0.50], [0.78, 0.06]],
  ],
  O: [
    [[0.50, 0.03], [0.28, 0.08], [0.14, 0.24], [0.09, 0.45], [0.10, 0.64], [0.18, 0.83], [0.34, 0.95], [0.53, 0.97], [0.70, 0.90], [0.83, 0.74], [0.88, 0.51], [0.87, 0.31], [0.79, 0.15], [0.63, 0.05], [0.50, 0.03]],
  ],
  P: [
    [[0.24, 0.05], [0.24, 0.51], [0.24, 0.96]],
    [[0.24, 0.06], [0.54, 0.05], [0.71, 0.15], [0.72, 0.33], [0.58, 0.45], [0.36, 0.48], [0.24, 0.48]],
  ],
  Q: [
    [[0.50, 0.03], [0.28, 0.08], [0.14, 0.24], [0.09, 0.45], [0.10, 0.64], [0.18, 0.83], [0.34, 0.95], [0.53, 0.97], [0.70, 0.90], [0.83, 0.74], [0.88, 0.51], [0.87, 0.31], [0.79, 0.15], [0.63, 0.05], [0.50, 0.03]],
    [[0.56, 0.66], [0.82, 0.98]],
  ],
  R: [
    [[0.24, 0.05], [0.24, 0.51], [0.24, 0.96]],
    [[0.24, 0.06], [0.54, 0.05], [0.71, 0.15], [0.72, 0.33], [0.58, 0.45], [0.36, 0.48], [0.24, 0.48]],
    [[0.48, 0.48], [0.76, 0.96], [0.60, 0.68]],
  ],
  S: [
    [[0.82, 0.20], [0.66, 0.07], [0.44, 0.03], [0.25, 0.12], [0.24, 0.28], [0.38, 0.42], [0.58, 0.52], [0.74, 0.66], [0.72, 0.83], [0.53, 0.95], [0.30, 0.94], [0.15, 0.83]],
  ],
  T: [
    [[0.10, 0.06], [0.50, 0.05], [0.90, 0.06]],
    [[0.50, 0.05], [0.50, 0.51], [0.50, 0.96]],
  ],
  U: [
    [[0.20, 0.05], [0.20, 0.45], [0.22, 0.74], [0.35, 0.92], [0.55, 0.93], [0.72, 0.78], [0.78, 0.49], [0.78, 0.06]],
  ],
  V: [
    [[0.14, 0.05], [0.50, 0.96]],
    [[0.50, 0.96], [0.86, 0.05]],
  ],
  W: [
    [[0.08, 0.05], [0.06, 0.48], [0.07, 0.91], [0.23, 0.50], [0.38, 0.13], [0.52, 0.52], [0.65, 0.89], [0.79, 0.45], [0.90, 0.06]],
  ],
  X: [
    [[0.14, 0.06], [0.50, 0.51], [0.86, 0.96]],
    [[0.86, 0.06], [0.50, 0.51], [0.14, 0.96]],
  ],
  Y: [
    [[0.16, 0.06], [0.50, 0.51]],
    [[0.84, 0.06], [0.50, 0.51]],
    [[0.50, 0.51], [0.50, 0.96]],
  ],
  Z: [
    [[0.16, 0.06], [0.50, 0.05], [0.84, 0.06], [0.50, 0.50], [0.20, 0.94], [0.50, 0.96], [0.84, 0.95]],
  ],

  // ------------------------------------------------------------ symbols ---
  // Every glyph needs a non-degenerate bounding box on BOTH axes: the matcher
  // normalizes into the glyph's own bbox, so a perfectly flat or vertical glyph
  // divides by zero and poisons the feature vector with NaN. Dashes therefore
  // sag a little and the exclamation mark leans and carries a square dot.
  '-': [
    [[0.16, 0.47], [0.50, 0.53], [0.84, 0.49]],
  ],
  '/': [
    [[0.78, 0.06], [0.50, 0.50], [0.22, 0.94]],
  ],
  '+': [
    [[0.18, 0.50], [0.50, 0.50], [0.82, 0.50]],
    [[0.50, 0.18], [0.50, 0.50], [0.50, 0.82]],
  ],
  '=': [
    [[0.18, 0.39], [0.50, 0.41], [0.82, 0.39]],
    [[0.18, 0.61], [0.50, 0.63], [0.82, 0.61]],
  ],
  '?': [
    [[0.18, 0.22], [0.28, 0.08], [0.50, 0.04], [0.68, 0.12], [0.66, 0.30], [0.50, 0.44], [0.50, 0.60]],
    [[0.50, 0.80], [0.50, 0.94]],
  ],
  '!': [
    [[0.50, 0.04], [0.53, 0.50], [0.52, 0.66]],
    [[0.42, 0.85], [0.58, 0.85], [0.58, 0.96], [0.42, 0.96], [0.42, 0.85]],
  ],
  // '○' is nearly circular (aspect ≈ 1) while '0' is tall and thin and 'O' sits
  // in between, so the three stay separable after bbox normalization.
  '○': [
    [[0.50, 0.05], [0.24, 0.14], [0.06, 0.38], [0.06, 0.62], [0.24, 0.86], [0.50, 0.95], [0.76, 0.86], [0.94, 0.62], [0.94, 0.38], [0.76, 0.14], [0.50, 0.05]],
  ],
  '✓': [
    [[0.14, 0.48], [0.36, 0.78], [0.60, 0.22], [0.86, 0.06], [0.68, 0.30]],
  ],
};

/**
 * Curvy variants: same glyph family plus this suffix, drawn with arcs.
 *
 * Every value must be a real point set (`[[[x, y], ...]]`). Earlier revisions
 * carried `'0c': ['0']` style string aliases here, which the loop below copied
 * into STROKES verbatim — so `STROKES['0c'][0]` was the string `'0'`, and any
 * code doing `stroke[0].x` got `undefined` and NaN. Aliases carried no extra
 * information anyway (the matcher already has the base glyph), so they are
 * simply gone, and the loop now rejects malformed entries instead of silently
 * poisoning the table.
 */
const CURVY = {
  '8c': [[[0.42, 0.46], [0.28, 0.36], [0.26, 0.21], [0.38, 0.08], [0.57, 0.05], [0.72, 0.15], [0.73, 0.30], [0.60, 0.42], [0.42, 0.46], [0.27, 0.58], [0.23, 0.76], [0.34, 0.91], [0.53, 0.95], [0.70, 0.87], [0.76, 0.71], [0.68, 0.57], [0.55, 0.49], [0.42, 0.46]]],
  '9c': [[[0.74, 0.30], [0.66, 0.42], [0.48, 0.50], [0.30, 0.46], [0.22, 0.32], [0.26, 0.16], [0.42, 0.06], [0.60, 0.06], [0.74, 0.18], [0.79, 0.36], [0.75, 0.58], [0.66, 0.77], [0.52, 0.91], [0.36, 0.97]]],
};

/** True for a value shaped `[[[x, y], ...], ...]` with >= 2 points per stroke. */
export function isPointSet(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (stroke) =>
      Array.isArray(stroke) &&
      stroke.length >= 2 &&
      stroke.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])),
  );
}

/**
 * Convert a table entry `[[[x, y], ...], ...]` into the `[[{x, y}, ...], ...]`
 * shape every consumer outside this file uses (engine, recognizer, renderer).
 *
 * This exists because the table stores compact `[x, y]` pairs, and the mismatch
 * has already caused a real bug once: a test iterated strokes and did
 * `{ ...stroke[i] }`, which produced `{0: 0.22, 1: 0.05}` — no `.x`, so every
 * coordinate became NaN and the whole handwriting harness silently failed.
 * Always go through here instead of touching STROKES entries directly.
 */
export function toPoints(value) {
  const strokes = Array.isArray(value) && Array.isArray(value[0]) && Array.isArray(value[0][0])
    ? value
    : [value];
  return strokes.map((stroke) =>
    stroke.map((p) => (Array.isArray(p)
      ? { x: Number(p[0]), y: Number(p[1]) }
      : { x: Number(p.x), y: Number(p.y) })),
  );
}

/** Appended to STROKES so both draw styles are available to the matcher. */for (const [key, shapes] of Object.entries(CURVY)) {
  if (!isPointSet(shapes)) {
    console.warn(`[glyphs] skipping malformed variant "${key}"`);
    continue;
  }
  STROKES[key] = shapes;
}

/** Keys that must never be offered as a suggestion in the UI. */
export const HIDDEN_KEYS = new Set(Object.keys(CURVY));

/** Friendly labels for the on-screen keyboard / suggestion chips. */
export const CATEGORIES = [
  { id: 'digits', label: '数字', keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] },
  { id: 'alpha', label: '字母', keys: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
  { id: 'symbols', label: '符号', keys: ['-', '/', '+', '=', '?', '!', '○', '✓'] },
];

/** Visible keys, in table order — the matcher's candidate set. */
export const BUILTIN_KEYS = Object.keys(STROKES).filter((key) => !HIDDEN_KEYS.has(key));
