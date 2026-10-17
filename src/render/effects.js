/**
 * Effect registry — the plug-in point for the interaction the user actually wants.
 *
 * Each effect is a factory: `createXxxEffect(config) -> { id, label, defaultOn,
 * reset(), update(ctx), draw(ctx, fx) }`.
 *
 *   update(frame)  advance state. `frame` = { hands, mapper, particles, dt, time,
 *                  width, height, detector }
 *   draw(ctx, frame) paint on top of the shared particle layer.
 *
 * Adding a new visual is therefore a single file: no edits to app.js are needed
 * beyond appending it to the list in app.js.
 *
 * Two reference effects ship here:
 *   - `sparks`  : fingertip emission whose rate and hue follow hand speed.
 *   - `pinchBurst`: closing the thumb/index pinch fires a shockwave + burst.
 */

import { FINGERS } from '../vision/hands.js';
import { clamp, glow, hsl, ease } from './draw.js';
import { ParticleSystem } from './particles.js';

/** Trails of sparks from every fingertip; brighter and faster when you move. */
export function createSparkEffect(options = {}) {
  const prev = new Map(); // "hand:finger" -> {x, y}

  return {
    id: 'sparks',
    label: '指尖星火',
    defaultOn: true,
    /**
     * Mutable config, also handed to the panel's “强度” slider. The closure
     * reads `config.intensity` every frame, so live edits actually take effect.
     */
    config: { intensity: options.intensity ?? 1 },

    reset() {
      prev.clear();
    },

    update({ hands, mapper, particles, dt }) {
      const { intensity } = this.config;
      if (!hands || !hands.length) return;
      const live = new Set();

      for (const hand of hands) {
        for (const [name, def] of Object.entries(FINGERS)) {
          const key = `${hand.index}:${name}`;
          live.add(key);
          const p = mapper.point(hand.screen[def.tip]);
          const before = prev.get(key);
          let speed = 0;
          if (before && dt > 0) {
            speed = Math.hypot(p.x - before.x, p.y - before.y) / dt;
          }
          prev.set(key, { x: p.x, y: p.y });

          const motion = clamp(speed / 1400, 0, 1); // px/s -> 0..1
          const base = name === 'thumb' ? 10 : 34;
          const rate = (base + motion * 240) * intensity;
          if (Math.random() > clamp(rate * dt, 0, 1)) continue;

          const angle = Math.random() * Math.PI * 2;
          particles.emit({
            x: p.x,
            y: p.y,
            angle,
            speed: 25 + motion * 210 + Math.random() * 45,
            life: 0.45 + Math.random() * 0.6,
            size: 1.6 + Math.random() * 2.4,
            hue: 28 + motion * 34 + (Math.random() - 0.5) * 22,
            drag: 0.9,
            gravity: 40,
            bright: motion > 0.55,
            flicker: 0.35,
            alpha: 0.75 + 0.25 * motion,
          });
        }
      }

      for (const key of [...prev.keys()]) if (!live.has(key)) prev.delete(key);
    },

    draw() {},
  };
}

/** Thumb+index pinch -> shockwave ring and radial burst. Fires once per close. */
export function createPinchBurstEffect({ threshold = 0.38, releaseAt = 0.5 } = {}) {
  const armed = new Map(); // hand.index -> bool
  const rings = [];        // {x, y, r, life, maxLife, hue}

  return {
    id: 'pinchBurst',
    label: '捏合爆闪',
    defaultOn: true,

    reset() {
      armed.clear();
      rings.length = 0;
    },

    update({ hands, mapper, particles, dt }) {
      const seen = new Set();
      for (const hand of hands || []) {
        seen.add(hand.index);
        const isArmed = armed.get(hand.index) ?? true;
        const p = mapper.point(hand.screen[8]);
        const t = mapper.point(hand.screen[4]);
        const mid = { x: (p.x + t.x) / 2, y: (p.y + t.y) / 2 };

        if (isArmed && hand.pinch < threshold) {
          armed.set(hand.index, false);
          rings.push({ x: mid.x, y: mid.y, r: 8, life: 0.55, maxLife: 0.55, hue: 50 });
          particles.burst(mid.x, mid.y, 46, {
            speed: 420,
            life: 0.65,
            size: 2.8,
            hue: 48,
            hueJitter: 40,
            gravity: 60,
            drag: 0.88,
            bright: true,
          });
        } else if (!isArmed && hand.pinch > releaseAt) {
          armed.set(hand.index, true);
        }
      }
      for (const key of [...armed.keys()]) if (!seen.has(key)) armed.delete(key);

      for (let i = rings.length - 1; i >= 0; i -= 1) {
        const ring = rings[i];
        ring.life -= dt;
        ring.r += dt * 640;
        if (ring.life <= 0) rings.splice(i, 1);
      }
    },

    draw(ctx, { time }) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const ring of rings) {
        const t = clamp(ring.life / ring.maxLife, 0, 1);
        ctx.strokeStyle = hsl(ring.hue, 100, 65, 0.55 * t);
        ctx.lineWidth = 2 + 5 * t;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = hsl(ring.hue + 25, 100, 80, 0.3 * t);
        ctx.lineWidth = 1 + 2 * t;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r * 0.72, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

/**
 * "Aura": a soft halo locked to the palm, sized by how close the hand is to the
 * camera. Cheap, and a good sanity check that depth (`hand.scale`) is tracking.
 */
export function createPalmAuraEffect() {
  const halos = new Map();

  return {
    id: 'palmAura',
    label: '掌心光晕',
    defaultOn: true,

    reset() {
      halos.clear();
    },

    update({ hands, mapper, dt }) {
      const seen = new Set();
      for (const hand of hands || []) {
        seen.add(hand.index);
        const target = mapper.point(hand.palmCenter);
        const existing = halos.get(hand.index);
        const k = ease(18, dt);
        if (existing) {
          existing.x += (target.x - existing.x) * k;
          existing.y += (target.y - existing.y) * k;
          existing.scale += (hand.scale - existing.scale) * ease(6, dt);
          existing.pinch += (hand.pinch - existing.pinch) * ease(10, dt);
          existing.alpha += ((hand.score || 0.8) - existing.alpha) * ease(6, dt);
        } else {
          halos.set(hand.index, {
            x: target.x,
            y: target.y,
            scale: hand.scale,
            pinch: hand.pinch,
            alpha: 0,
          });
        }
      }
      for (const key of [...halos.keys()]) if (!seen.has(key)) halos.delete(key);
    },

    draw(ctx, { width, height }) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const [index, halo] of halos) {
        const radius = clamp(halo.scale * width * 2.6, 40, 420);
        const hue = index === 0 ? 275 : 200;
        const heat = clamp(1 - halo.pinch / 1.2, 0, 1);
        glow(ctx, halo.x, halo.y, radius, hsl(hue, 95, 62), 0.35 * halo.alpha);
        ctx.strokeStyle = hsl(hue + 30 * heat, 100, 70, 0.25 + 0.35 * heat);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(halo.x, halo.y, radius * (0.55 + 0.3 * heat), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

/** Shared particle layer, exposed so custom effects can reuse the pool. */
export function createParticleLayer(capacity = 3000) {
  return new ParticleSystem(capacity);
}
