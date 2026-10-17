/**
 * Small numeric helpers shared by the vision and air-writing code.
 *
 * Everything here is allocation-light: these run 20-60 times per second for
 * every tracked hand and for every stroke sample.
 */

/** Frame-rate independent exponential smoothing. */
export class SmoothedValue {
  /**
   * @param {number} alpha 0..1 fraction of the new value kept per update
   * @param {number} initial starting value
   */
  constructor(alpha = 0.5, initial = 0) {
    this.alpha = alpha;
    this.value = initial;
    this.lastTime = 0;
  }

  /** Blend in `next`; `dt`-aware when `now` is supplied. */
  push(next, now = 0) {
    if (!Number.isFinite(next)) return this.value;
    if (!this.lastTime || !now) {
      this.value = next;
      this.lastTime = now || 1;
      return this.value;
    }
    const dt = Math.max(1, Math.min(200, now - this.lastTime)) / 16.667;
    // alpha is defined for a 60 fps step; scale it for the real frame time.
    const a = 1 - Math.pow(1 - this.alpha, dt);
    this.value += (next - this.value) * a;
    this.lastTime = now;
    return this.value;
  }

  reset(value = 0) {
    this.value = value;
    this.lastTime = 0;
  }
}

/**
 * 1€ filter (Casiez et al. 2012) for a stream of 3D points.
 *
 * The point of the 1€ filter over a fixed exponential smoother is that the
 * cutoff adapts to speed: a slow fingertip is smoothed hard (no jitter) while a
 * fast stroke is barely filtered (no lag). That matters here because jitter
 * makes the air-written glyphs unreadable and lag makes them misshapen.
 */
export class OneEuroPointFilter {
  /**
   * @param {{minCutoff?:number, beta?:number, derivateCutoff?:number}} [options]
   *   minCutoff: cutoff at zero speed (lower = smoother, 1.0-1.5 is a good hand)
   *   beta: how strongly speed raises the cutoff (0.01-0.05 for normalized coords)
   */
  constructor({ minCutoff = 1.2, beta = 0.02, derivateCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivateCutoff = derivateCutoff;
    this.x = null; // filtered point
    this.dx = { x: 0, y: 0, z: 0 }; // filtered derivative
    this.t = 0;
    this.initialized = false;
  }

  #alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoff));
    return 1 / (1 + tau / Math.max(1e-6, dt));
  }

  /**
   * @param {number} x @param {number} y @param {number} [z] @param {number} now ms
   * @returns {{x:number,y:number,z:number}}
   */
  filter(x, y, z = 0, now = 0) {
    if (!this.initialized) {
      this.x = { x, y, z };
      this.dx = { x: 0, y: 0, z: 0 };
      this.t = now || 1;
      this.initialized = true;
      return { ...this.x };
    }
    const dt = Math.max(1e-3, Math.min(0.2, ((now || this.t + 16) - this.t) / 1000));
    this.t = now || this.t + 16;

    // 1) derivative of the *raw* signal, itself low-pass filtered
    const rawDx = { x: (x - this.x.x) / dt, y: (y - this.x.y) / dt, z: (z - this.x.z) / dt };
    const dAlpha = this.#alpha(this.derivateCutoff, dt);
    this.dx.x += (rawDx.x - this.dx.x) * dAlpha;
    this.dx.y += (rawDx.y - this.dx.y) * dAlpha;
    this.dx.z += (rawDx.z - this.dx.z) * dAlpha;

    // 2) cutoff rises with speed, so fast motion is not over-smoothed
    const speed = Math.hypot(this.dx.x, this.dx.y, this.dx.z);
    const cutoff = this.minCutoff + this.beta * speed;
    const a = this.#alpha(cutoff, dt);
    this.x.x += (x - this.x.x) * a;
    this.x.y += (y - this.x.y) * a;
    this.x.z += (z - this.x.z) * a;
    return { ...this.x };
  }

  reset() {
    this.initialized = false;
    this.t = 0;
    this.dx = { x: 0, y: 0, z: 0 };
  }
}

/** Per-key 2D smoothing with a fixed time constant, in milliseconds. */
export class PointSmoother {
  constructor(tau = 45) {
    this.tau = tau;
    this.points = new Map();
  }

  /**
   * @param {string} key stable identity (e.g. "Left:index:tip")
   * @param {{x:number,y:number}} point raw point
   * @param {number} now timestamp in ms
   */
  push(key, point, now) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return point;
    const prev = this.points.get(key);
    if (!prev) {
      const fresh = { x: point.x, y: point.y, t: now };
      this.points.set(key, fresh);
      return fresh;
    }
    const dt = Math.max(1, now - prev.t);
    const a = 1 - Math.exp(-dt / this.tau);
    prev.x += (point.x - prev.x) * a;
    prev.y += (point.y - prev.y) * a;
    prev.t = now;
    return prev;
  }

  get(key) {
    return this.points.get(key) ?? null;
  }

  /** Forget keys that were not touched this frame (they may come back later). */
  prune(liveKeys) {
    for (const key of [...this.points.keys()]) {
      if (!liveKeys.has(key)) this.points.delete(key);
    }
  }

  clear() {
    this.points.clear();
  }
}

/** Smooth an entire landmark array in place, preserving z. */
export function smoothLandmarks(smoother, keyPrefix, landmarks, now) {
  if (!landmarks) return landmarks;
  for (let i = 0; i < landmarks.length; i += 1) {
    const point = landmarks[i];
    const smoothed = smoother.push(`${keyPrefix}:${i}`, point, now);
    if (smoothed !== point) {
      point.x = smoothed.x;
      point.y = smoothed.y;
    }
  }
  return landmarks;
}

export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest distance from point p to segment a-b, plus the projected parameter. */
export function distanceToSegment(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-9) return { distance: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq;
  t = clamp(t, 0, 1);
  const cx = a.x + vx * t;
  const cy = a.y + vy * t;
  return { distance: Math.hypot(p.x - cx, p.y - cy), t };
}

export function pointsBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/** Path length of a polyline. */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/**
 * Resample a polyline to exactly `count` evenly spaced points.
 * Returns a new array; the input is not modified.
 */
export function resamplePolyline(points, count) {
  if (!points.length) {
    return Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  }
  if (points.length === 1) {
    return Array.from({ length: count }, () => ({ x: points[0].x, y: points[0].y }));
  }

  // Cumulative length per vertex: resampling is then a linear walk.
  const lengths = new Float64Array(points.length);
  for (let i = 1; i < points.length; i += 1) {
    lengths[i] = lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = lengths[points.length - 1];
  if (total <= 1e-9) {
    return Array.from({ length: count }, () => ({ x: points[0].x, y: points[0].y }));
  }

  const out = new Array(count);
  const step = total / (count - 1);
  out[0] = { x: points[0].x, y: points[0].y };
  let cursor = 1;
  for (let i = 1; i < count - 1; i += 1) {
    const target = step * i;
    while (cursor < points.length - 1 && lengths[cursor] < target) cursor += 1;
    const segStart = lengths[cursor - 1];
    const segLength = lengths[cursor] - segStart;
    const t = segLength > 1e-9 ? (target - segStart) / segLength : 0;
    out[i] = {
      x: points[cursor - 1].x + (points[cursor].x - points[cursor - 1].x) * t,
      y: points[cursor - 1].y + (points[cursor].y - points[cursor - 1].y) * t,
    };
  }
  out[count - 1] = { x: points[points.length - 1].x, y: points[points.length - 1].y };
  return out;
}
