/**
 * Synthetic hand generator.
 *
 * Running the real pipeline needs a camera AND a 7-8 MB model file. When either
 * is missing (or when you just want to develop an effect without sitting in
 * front of the webcam), this produces landmark data with the exact shape the
 * hands tracker emits, so every renderer and effect works unchanged.
 *
 * `DemoRig` implements the same public surface as `Rig`, so app.js does not
 * care which one it is driving.
 */

import { FINGERS } from './vision/hands.js';

/** Rest-pose hand, in normalized video coordinates, wrist at the origin. */
const REST_LANDMARKS = [
  [0.0, 0.0],       // 0 wrist
  [-0.052, -0.018], // 1 thumb cmc
  [-0.086, -0.062], // 2 thumb mcp
  [-0.108, -0.094], // 3 thumb ip
  [-0.122, -0.124], // 4 thumb tip
  [-0.038, -0.086], // 5 index mcp
  [-0.042, -0.136], // 6 index pip
  [-0.046, -0.176], // 7 index dip
  [-0.048, -0.208], // 8 index tip
  [-0.008, -0.09],  // 9 middle mcp
  [-0.01, -0.146],  // 10
  [-0.012, -0.19],  // 11
  [-0.014, -0.224], // 12 middle tip
  [0.022, -0.086],  // 13 ring mcp
  [0.024, -0.138],  // 14
  [0.026, -0.178],  // 15
  [0.028, -0.208],  // 16 ring tip
  [0.052, -0.078],  // 17 pinky mcp
  [0.056, -0.12],   // 18
  [0.058, -0.152],  // 19
  [0.06, -0.18],    // 20 pinky tip
];

/** Pretend the hand is this wide in normalized units, for pinch/scale math. */
const PALM_SPAN = 0.098;

function curvature(fingers, t) {
  // 0 = straight, 1 = fully curled (tip pulled back toward the palm)
  const out = new Array(21).fill(0);
  for (const name of Object.keys(FINGERS)) {
    const f = FINGERS[name];
    out[f.tip] = fingers[name] ?? 0;
    out[f.tip - 1] = (fingers[name] ?? 0) * 0.6;
    out[f.pip] = (fingers[name] ?? 0) * 0.22;
  }
  return out;
}

function poseAt(t, opts) {
  const curl = {
    thumb: 0.25 + 0.25 * Math.sin(t * 1.7),
    index: 0.5 + 0.5 * Math.sin(t * 1.1),
    middle: 0.5 + 0.5 * Math.sin(t * 0.9 + 1.1),
    ring: 0.5 + 0.5 * Math.sin(t * 1.3 + 2.2),
    pinky: 0.5 + 0.5 * Math.sin(t * 1.5 + 3.1),
  };
  if (opts.pinchCycle) {
    const phase = (t * 0.55) % (Math.PI * 2);
    const close = Math.max(0, Math.sin(phase));
    curl.thumb = 0.9 * close;
    curl.index = 0.9 * close;
  }
  const curls = curvature(curl, t);
  return curls;
}

/**
 * @param {object} opts
 * @param {number} [opts.pointers] 1 or 2 synthetic hands
 * @param {boolean} [opts.pinchCycle] animate a repeating pinch
 */
export function createDemoFrames({ pointers = 1, pinchCycle = true } = {}) {
  return function frames({ ts }) {
    const t = ts / 1000;
    const hands = [];

    for (let h = 0; h < pointers; h += 1) {
      const curls = poseAt(t + h * 2.3, { pinchCycle });
      const scale = 0.66 + 0.12 * Math.sin(t * 0.6 + h * 1.7); // hand size on screen
      const cx = 0.5 + (h === 0 ? 0.16 : -0.18) + 0.1 * Math.sin(t * 0.75 + h * 2.1);
      const cy = 0.56 + 0.09 * Math.cos(t * 0.9 + h * 1.3);
      const rot = 0.35 * Math.sin(t * 0.5 + h * 1.9) + (h === 1 ? Math.PI : 0);

      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const screen = REST_LANDMARKS.map(([x, y], i) => {
        // apply curl: pull the finger chain toward the wrist as `curl` grows
        const c = curls[i];
        const pulled = { x: x * (1 - 0.45 * c), y: y * (1 - 0.55 * c) };
        const sx = pulled.x * scale;
        const sy = pulled.y * scale * 1.15;
        return {
          x: cx + (sx * cos - sy * sin),
          y: cy + (sx * sin + sy * cos),
          z: -0.02 * c,
        };
      });

      hands.push({
        index: h,
        screen,
        world: REST_LANDMARKS.map(([x, y]) => ({ x: x * 0.2 * scale, y: -y * 0.2 * scale, z: 0 })),
        label: h === 0 ? 'Right' : 'Left',
        score: 0.99,
        ...measure(screen, scale),
      });
    }
    return { hands };
  };
}

function measure(screen, scale) {
  const wrist = screen[0];
  const middleMcp = screen[9];
  const palmSpan = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y) || PALM_SPAN * scale;
  return {
    wrist,
    palmCenter: {
      x: (wrist.x + middleMcp.x + screen[5].x + screen[17].x) / 4,
      y: (wrist.y + middleMcp.y + screen[5].y + screen[17].y) / 4,
      z: 0,
    },
    indexTip: screen[8],
    thumbTip: screen[4],
    pinch: Math.hypot(screen[4].x - screen[8].x, screen[4].y - screen[8].y) / (palmSpan || 1e-6),
    scale: palmSpan,
    worldScale: palmSpan * 0.2,
  };
}
