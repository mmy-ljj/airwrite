/**
 * Small canvas helpers shared by the effect renderers.
 * Everything here is allocation-light: the render loop runs at 60 fps and the
 * particle systems can push thousands of segments per second.
 */

/** Rounded rectangle path (kept local so draw.js has no dependencies). */
export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Draw a soft radial glow. `intensity` 0..1 scales alpha only, so a single
 * gradient object could be reused if hot spots ever show up in profiling.
 */
export function glow(ctx, x, y, radius, color, intensity = 1) {
  if (radius <= 0 || intensity <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, withAlpha(color, 0.85 * intensity));
  g.addColorStop(0.4, withAlpha(color, 0.28 * intensity));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Additive-stroke segment with rounded caps: the cheapest way to get a neon
 * look on canvas 2d. `ctx.globalCompositeOperation` is left untouched.
 */
export function neonLine(ctx, x1, y1, x2, y2, width, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = width * 2.6;
  ctx.globalAlpha = alpha * 0.18;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/** `hsl()` string from 0..360 hue, with alpha. */
export function hsl(h, s, l, a = 1) {
  return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
}

/** Accepts `#rgb`, `#rrggbb` or `hsl(...)`; returns an `rgba()` string. */
export function withAlpha(color, alpha) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  if (color.startsWith('hsla(')) return color.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  return color;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent easing factor for "approach target" smoothing. */
export function ease(ratePerSecond, dt) {
  return 1 - Math.exp(-ratePerSecond * dt);
}
