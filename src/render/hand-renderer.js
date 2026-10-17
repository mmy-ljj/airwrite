/**
 * Hand overlay renderer: skeleton, joints, per-finger hues, pinch ring and
 * handedness tags. This is the "debug + base look" layer that effects build on.
 */

import { HAND_CONNECTIONS, FINGERS } from '../vision/hands.js';
import { glow, neonLine, hsl, withAlpha } from './draw.js';

/** Hue per finger so a gesture is readable at a glance. */
export const FINGER_HUE = {
  thumb: 8,
  index: 45,
  middle: 150,
  ring: 200,
  pinky: 285,
};

/** For each landmark id, which finger it belongs to (0 = wrist / palm). */
const LANDMARK_FINGER = (() => {
  const map = new Array(21).fill('palm');
  for (const [name, f] of Object.entries(FINGERS)) {
    map[f.mcp] = name;
    map[f.pip] = name;
    if (f.tip !== f.pip) map[f.tip] = name;
    // fill the joint between pip and tip
    for (let i = f.pip + 1; i < f.tip; i += 1) map[i] = name;
  }
  return map;
})();

export class HandRenderer {
  constructor(opts = {}) {
    this.options = {
      skeleton: true,
      joints: true,
      labels: true,
      pinchRing: true,
      trails: true,
      ...opts,
    };
    /** Short motion trails per fingertip, keyed by "handIndex:finger". */
    this.trails = new Map();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./mapper.js').ViewMapper} mapper
   * @param {Array} hands adapted results from the hands tracker
   * @param {{time: number, dt: number}} frame
   */
  draw(ctx, mapper, hands, frame = {}) {
    if (!hands || !hands.length) {
      if (this.options.trails) this.trails.clear();
      return;
    }
    const time = frame.time ?? performance.now();

    for (const hand of hands) {
      const pts = hand.screen.map((p) => mapper.point(p));
      const hue = hand.label === 'Left' ? 190 : 330;

      if (this.options.trails) this.#drawTrails(ctx, hand, pts, time, hue);

      if (this.options.skeleton) this.#drawSkeleton(ctx, pts, hue, hand);
      if (this.options.joints) this.#drawJoints(ctx, pts, hue, hand);
      if (this.options.pinchRing) this.#drawPinch(ctx, pts, hue, hand);
      if (this.options.labels) this.#drawLabel(ctx, pts, hue, hand);
    }
  }

  #drawSkeleton(ctx, pts, hue, hand) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [a, b] of HAND_CONNECTIONS) {
      const finger = LANDMARK_FINGER[b] !== 'palm' ? LANDMARK_FINGER[b] : LANDMARK_FINGER[a];
      const color = hsl(finger === 'palm' ? hue : FINGER_HUE[finger], 90, 62);
      const width = finger === 'palm' ? 4 : 3;
      neonLine(ctx, pts[a].x, pts[a].y, pts[b].x, pts[b].y, width, color, 0.95);
    }
    ctx.restore();
  }

  #drawJoints(ctx, pts, hue, hand) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < pts.length; i += 1) {
      const finger = LANDMARK_FINGER[i];
      const isTip = Object.values(FINGERS).some((f) => f.tip === i);
      const color = hsl(finger === 'palm' ? hue : FINGER_HUE[finger], 95, isTip ? 68 : 58);
      const r = isTip ? 7 : finger === 'palm' ? 5 : 4;
      glow(ctx, pts[i].x, pts[i].y, r * 3.2, color, isTip ? 0.9 : 0.6);
      ctx.fillStyle = withAlpha('#ffffff', isTip ? 0.92 : 0.75);
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, isTip ? 3 : 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** A ring that closes as thumb and index approach: the classic pinch affordance. */
  #drawPinch(ctx, pts, hue, hand) {
    const t = pts[4];
    const i = pts[8];
    const d = Math.hypot(t.x - i.x, t.y - i.y);
    const closed = Math.max(0, Math.min(1, 1 - (hand.pinch - 0.25) / 0.5));
    const mid = { x: (t.x + i.x) / 2, y: (t.y + i.y) / 2 };
    const r = Math.max(10, d / 2);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hsl(52, 100, 65, 0.35 + 0.5 * closed);
    ctx.lineWidth = 1.5 + 2.5 * closed;
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, r, 0, Math.PI * 2);
    ctx.stroke();
    if (closed > 0.02) {
      glow(ctx, mid.x, mid.y, 26 * closed + 8, hsl(52, 100, 70), closed);
    }
    ctx.restore();
  }

  #drawLabel(ctx, pts, hue, hand) {
    const top = pts.reduce((acc, p) => (p.y < acc.y ? p : acc), pts[0]);
    const text = `${hand.label === 'Left' ? '左手' : '右手'} ${(hand.score * 100).toFixed(0)}%`;
    ctx.save();
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = withAlpha('#ffffff', 0.85);
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 6;
    ctx.fillText(text, top.x + 10, top.y - 8);
    ctx.restore();
  }

  /** Fading polyline behind each fingertip; sampled at a fixed time step. */
  #drawTrails(ctx, hand, pts, time, hue) {
    const tips = Object.entries(FINGERS).map(([name, f]) => [name, pts[f.tip]]);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [name, p] of tips) {
      const key = `${hand.index}:${name}`;
      let trail = this.trails.get(key);
      if (!trail) {
        trail = [];
        this.trails.set(key, trail);
      }
      trail.push({ x: p.x, y: p.y, t: time });
      while (trail.length && time - trail[0].t > 420) trail.shift();
      if (trail.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(trail[0].x, trail[0].y);
      for (let i = 1; i < trail.length; i += 1) ctx.lineTo(trail[i].x, trail[i].y);
      ctx.strokeStyle = hsl(FINGER_HUE[name], 95, 65, 0.5);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Drop trails for hands/handedness that stopped being tracked. */
  prune(activeHandCount) {
    for (const key of [...this.trails.keys()]) {
      if (Number(key.split(':')[0]) >= activeHandCount) this.trails.delete(key);
    }
  }
}
