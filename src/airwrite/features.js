/**
 * Feature extraction for the air-writing recognizer.
 *
 * Everything is derived from *stroke point lists* (arrays of {x, y}) and is
 * invariant to where on the screen the character was drawn and to how large it
 * was. Rotation is intentionally NOT normalized away — a 6 and a 9, or a U and
 * an n, are told apart by their orientation.
 *
 * The feature set is deliberately small so a hand-written template library can
 * beat it: point cloud (chamfer), 8-bin direction histogram, 4x4 occupancy, and
 * aspect ratio.
 */

import { pointsBounds, resamplePolyline, polylineLength } from '../vision/smoothing.js';

export const FEATURE_VERSION = 1;

/** Combine several strokes into one polyline (order preserved). */
export function flattenStrokes(strokes) {
  const out = [];
  for (const stroke of strokes) {
    if (!stroke || !stroke.length) continue;
    for (const p of stroke) out.push(p);
  }
  return out;
}

/**
 * Normalize a whole character into a canonical 0..1 box.
 *
 * Returns the resampled point cloud plus the intermediate statistics the
 * matcher needs (aspect ratio, ink length).
 */
export function normalizeCharacter(strokes, { samples = 64 } = {}) {
  const all = flattenStrokes(strokes);
  const bounds = pointsBounds(all);
  const width = Math.max(bounds.width, 1e-6);
  const height = Math.max(bounds.height, 1e-6);
  const scale = 1 / Math.max(width, height);

  // Normalize every stroke with the same transform so relative stroke
  // positions survive, then pool and resample.
  const normalized = [];
  for (const stroke of strokes) {
    if (!stroke || stroke.length < 2) continue;
    const mapped = stroke.map((p) => ({
      x: (p.x - bounds.minX) * scale,
      y: (p.y - bounds.minY) * scale,
    }));
    normalized.push(mapped);
  }
  const pooled = flattenStrokes(normalized);
  const cloud = pooled.length >= 2 ? resamplePolyline(pooled, samples) : pooled;
  const inkLength = strokes.reduce((sum, s) => sum + (s?.length >= 2 ? polylineLength(s) : 0), 0);

  return {
    points: cloud,
    bounds,
    aspect: width / height,
    inkLength,
    normalizedStrokes: normalized,
    strokeCount: normalized.length,
  };
}

/**
 * 8-bin direction histogram of the normalized cloud.
 * Bins are aligned so bin 0 is "right"; 4 is "down" in screen coordinates.
 */
export function directionHistogram(points, bins = 8) {
  const hist = new Float32Array(bins);
  if (points.length < 2) return hist;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += Math.PI * 2;
    const bin = Math.floor((angle / (Math.PI * 2)) * bins) % bins;
    hist[bin] += len;
    total += len;
  }
  if (total > 0) for (let i = 0; i < bins; i += 1) hist[i] /= total;
  return hist;
}

/** Coarse occupancy grid over the normalized 0..1 box. */
export function occupancyGrid(points, size = 4) {
  const grid = new Float32Array(size * size);
  let count = 0;
  for (const p of points) {
    const cx = Math.min(size - 1, Math.max(0, Math.floor(p.x * size)));
    const cy = Math.min(size - 1, Math.max(0, Math.floor(p.y * size)));
    grid[cy * size + cx] += 1;
    count += 1;
  }
  if (count > 0) for (let i = 0; i < grid.length; i += 1) grid[i] /= count;
  return grid;
}

/**
 * Mean nearest-neighbour distance between two point clouds, in the normalized
 * 0..1 space. Symmetric (chamfer) so it is not biased by sampling density.
 */
export function chamferDistance(a, b) {
  if (!a.length || !b.length) return 1;
  return (meanNearest(a, b) + meanNearest(b, a)) / 2;
}

function meanNearest(from, to) {
  let total = 0;
  for (const p of from) {
    let best = Infinity;
    for (const q of to) {
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    total += Math.sqrt(best);
  }
  return total / from.length;
}

export function histogramDistance(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / 2; // total variation distance in 0..1
}

export function gridDistance(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / 2;
}

/**
 * Build the full descriptor for a set of strokes.
 * @returns {object|null} null when there is not enough ink
 */
export function extractFeatures(strokes, options = {}) {
  const normalized = normalizeCharacter(strokes, options);
  if (!normalized.points.length || normalized.inkLength < 4) return null;
  return {
    version: FEATURE_VERSION,
    points: normalized.points,
    histogram: directionHistogram(normalized.points, 8),
    grid: occupancyGrid(normalized.points, 4),
    aspect: normalized.aspect,
    strokeCount: normalized.strokeCount,
    inkLength: normalized.inkLength,
    bounds: normalized.bounds,
  };
}

/**
 * Similarity in 0..1 between a candidate descriptor and a template descriptor.
 * Weights were tuned against the bundled glyph library; chamfer dominates.
 */
export function featureDistance(a, b, weights = {}) {
  const w = { chamfer: 0.45, histogram: 0.25, grid: 0.15, aspect: 0.15, ...weights };
  const chamfer = chamferDistance(a.points, b.points);
  const histogram = histogramDistance(a.histogram, b.histogram);
  const grid = gridDistance(a.grid, b.grid);
  // Aspect ratio compared in log space so 2x too wide counts the same as 2x too tall.
  const aspect = Math.min(1, Math.abs(Math.log((a.aspect + 0.05) / (b.aspect + 0.05))) / Math.log(3));
  return w.chamfer * Math.min(1, chamfer * 2.4) + w.histogram * histogram + w.grid * grid + w.aspect * aspect;
}

export const similarity = (a, b, weights) => Math.max(0, 1 - featureDistance(a, b, weights)) ** 1.6;
