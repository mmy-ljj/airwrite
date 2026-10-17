/**
 * Pooled particle system for additive, trail-style sparks.
 *
 * One flat array of objects, reused forever, so 60 fps does not allocate. A
 * particle stores its previous position: every spark is drawn as a short
 * segment (a streak), which reads far better than a dot in motion.
 */

import { clamp } from './draw.js';

export class ParticleSystem {
  constructor(capacity = 3000) {
    this.capacity = capacity;
    this.particles = Array.from({ length: capacity }, () => ({
      active: false,
      x: 0, y: 0, px: 0, py: 0,
      vx: 0, vy: 0,
      life: 0, maxLife: 1,
      size: 2,
      drag: 0.92,
      gravity: 0,
      hue: 45,
      sat: 95,
      light: 65,
      alpha: 1,
      flicker: 0,
    }));
    this.cursor = 0;
    this.liveCount = 0;
  }

  /** Overwrite the oldest slot when the pool is exhausted. */
  #acquire() {
    const { particles, capacity } = this;
    for (let i = 0; i < capacity; i += 1) {
      const idx = (this.cursor + i) % capacity;
      if (!particles[idx].active) {
        this.cursor = (idx + 1) % capacity;
        return particles[idx];
      }
    }
    const p = particles[this.cursor];
    this.cursor = (this.cursor + 1) % capacity;
    return p;
  }

  /**
   * @param {object} o
   * @param {number} o.x
   * @param {number} o.y
   * @param {number} [o.vx]
   * @param {number} [o.vy]
   * @param {number} [o.spread]   rad/s of random angular jitter applied to v
   * @param {number} [o.speed]
   * @param {number} [o.life]     seconds
   * @param {number} [o.size]     px radius
   * @param {number} [o.hue]
   * @param {boolean} [o.bright]
   */
  emit(o) {
    const p = this.#acquire();
    const angle = o.angle ?? Math.atan2(o.vy ?? 0, o.vx ?? 1);
    const speed = o.speed ?? Math.hypot(o.vx ?? 0, o.vy ?? 0);
    const jitter = o.spread ? (Math.random() - 0.5 + Math.random() - 0.5) * o.spread : 0;
    const a = angle + jitter;
    p.active = true;
    p.x = o.x;
    p.y = o.y;
    p.px = o.x;
    p.py = o.y;
    p.vx = Math.cos(a) * speed + (o.vxAdd ?? 0);
    p.vy = Math.sin(a) * speed + (o.vyAdd ?? 0);
    p.life = o.life ?? 0.7;
    p.maxLife = p.life;
    p.size = o.size ?? 2.2;
    p.drag = o.drag ?? 0.9;
    p.gravity = o.gravity ?? 0;
    p.hue = o.hue ?? 45;
    p.sat = o.sat ?? 95;
    p.light = o.bright ? 78 : o.light ?? 63;
    p.alpha = o.alpha ?? 1;
    p.flicker = o.flicker ?? 0;
    return p;
  }

  /** Radial burst of `count` particles. */
  burst(x, y, count, opts = {}) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (opts.speed ?? 180) * (0.35 + Math.random() * 0.85);
      this.emit({
        x, y,
        angle,
        speed,
        life: (opts.life ?? 0.7) * (0.6 + Math.random() * 0.8),
        size: (opts.size ?? 2.4) * (0.6 + Math.random() * 0.9),
        hue: (opts.hue ?? 45) + (opts.hueJitter ?? 18) * (Math.random() - 0.5),
        drag: opts.drag,
        gravity: opts.gravity,
        bright: opts.bright,
        alpha: opts.alpha,
        flicker: opts.flicker,
      });
    }
  }

  /**
   * @param {number} dt seconds
   */
  update(dt) {
    let live = 0;
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.px = p.x;
      p.py = p.y;
      const drag = Math.pow(p.drag, dt * 60);
      p.vx *= drag;
      p.vy = p.vy * drag + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      live += 1;
    }
    this.liveCount = live;
  }

  /** Draw all live particles as additive streaks. */
  draw(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of this.particles) {
      if (!p.active) continue;
      const t = clamp(p.life / p.maxLife, 0, 1);
      const alpha = p.alpha * (0.25 + 0.75 * t) * (p.flicker ? 1 - p.flicker * Math.random() : 1);
      const size = Math.max(0.4, p.size * (0.35 + 0.65 * t));
      ctx.strokeStyle = `hsla(${p.hue}, ${p.sat}%, ${p.light}%, ${alpha})`;
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.strokeStyle = `hsla(${p.hue}, ${p.sat}%, 92%, ${alpha * 0.5})`;
      ctx.lineWidth = size * 0.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  clear() {
    for (const p of this.particles) p.active = false;
    this.liveCount = 0;
  }
}
