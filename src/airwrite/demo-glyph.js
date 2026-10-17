/**
 * 合成"捏笔写字"手演示帧（契约 docs/AIRWRITE-CONTRACT.md 第 4 节）。
 *
 * 用途：headless 自检里既没有摄像头也没有 MediaPipe 模型，用这只合成手沿
 * src/airwrite/glyphs.js 的 `STROKES[key]` 逐笔"捏着写"，从而端到端验证
 * 「engine + recognizer」通路（Lead 的 tests/airwrite-selftest.html 用它写 A5HI）。
 *
 * 设计要点（为什么这样写，而不是随手造 21 个点）
 * ---------------------------------------------------------------
 * 1) 手模板归一化到"手掌跨度 = 1"（手掌跨度 = |landmark9 - landmark0|，
 *    与 src/demo-frames.js / src/vision/hands.js 的 palmSpan 定义一致），
 *    再做**等比缩放 + 旋转 + 平移**得到屏幕坐标。
 *    等比缩放与旋转都是等距变换 ⇒ `classifyHand` 用到的关节角、半径增益、
 *    各指 span / 手掌跨度 等比值全部与旋转无关。于是姿态判定可以离线推理，
 *    不需要靠调参碰运气。
 * 2) 中指 / 无名指 / 小指按 95°/节 卷向手腕（指尖半径增益为负 → curled），
 *    食指保持 REST 伸直姿态（关节角 ≈ 180° → extended）⇒
 *    `classifyHand(screen).gesture === 'pen'`，**不是 'palm'**
 *    （palm 需要四指全伸 + openness ≥ 4.5，四指中三指卷起时不可能成立）。
 * 3) 拇指尖位置**由目标 pinch 反解**：先算 palmSpan，再把 landmark 4 放到
 *    `L8 + d·û`（d = ratio × palmSpan，û = 原拇指方向）⇒ measure() 里的
 *    `pinch = |L4-L8| / palmSpan` **精确等于** ratio（浮点误差级别）。
 *    抖动只旋转 û、不改 d，所以 pinch 的精确性不受抖动影响。
 * 4) 运动学：所有坐标都是"虚拟时钟"的函数，虚拟时钟每帧最多前进 16.7 ms
 *    （= 单帧位移上限 0.025 / 速度 0.0015）⇒ 无论调用方用什么 ts 步长，
 *    单帧位移都有硬上限，不会"瞬移"。
 * 5) 几何：手的包围盒（相对笔尖的偏移）随旋转角变化，本模块在 0..360° 内
 *    搜索让"笔尖可用框"最大的角度，再把字形映射到其中的正方形框里。
 *    可用框的计算已经扣掉 jitter 与拇指弯折的安全边距 pad，因此
 *    **所有 21 个点**都落在契约要求的 0.15..0.85 内。
 */

import { STROKES } from './glyphs.js';
import { classifyHand } from '../vision/gestures.js';

/* ------------------------------------------------------------------ 模板 --- */

/**
 * 静息手，归一化视频坐标，手腕在原点。数值与 src/demo-frames.js 的
 * REST_LANDMARKS 完全一致（那边没有导出，这里复制常量，避免为一个常量
 * 去改动别人的文件）。
 */
const REST_LANDMARKS = [
  [0.0, 0.0],       // 0 手腕
  [-0.052, -0.018], // 1 拇指 cmc
  [-0.086, -0.062], // 2 拇指 mcp
  [-0.108, -0.094], // 3 拇指 ip
  [-0.122, -0.124], // 4 拇指尖
  [-0.038, -0.086], // 5 食指 mcp
  [-0.042, -0.136], // 6 食指 pip
  [-0.046, -0.176], // 7 食指 dip
  [-0.048, -0.208], // 8 食指尖
  [-0.008, -0.09],  // 9 中指 mcp
  [-0.01, -0.146],  // 10
  [-0.012, -0.19],  // 11
  [-0.014, -0.224], // 12 中指端
  [0.022, -0.086],  // 13 无名指 mcp
  [0.024, -0.138],  // 14
  [0.026, -0.178],  // 15
  [0.028, -0.208],  // 16 无名指端
  [0.052, -0.078],  // 17 小指 mcp
  [0.056, -0.12],   // 18
  [0.058, -0.152],  // 19
  [0.06, -0.18],    // 20 小指端
];

/** 模板手掌跨度（|L9 - L0|），把模板缩放到"手掌跨度 = 1"。 */
const PALM_SPAN_REST = Math.hypot(
  REST_LANDMARKS[9][0] - REST_LANDMARKS[0][0],
  REST_LANDMARKS[9][1] - REST_LANDMARKS[0][1],
);

/** landmark 索引：[mcp, pip, dip, tip]。食指(5..8)故意不在此列，保持伸直。 */
const CURLED_CHAINS = [
  [9, 10, 11, 12],   // middle
  [13, 14, 15, 16],  // ring
  [17, 18, 19, 20],  // pinky
];

/** 卷指时每一节的相对弯曲角（度）。90° 以上才能保证 curled（≤122°）。 */
const CURL_DEG = 95;

/* --------------------------------------------------------------- 运动参数 --- */

const PINCH_DOWN = 0.15;  // 写字时 pinch 目标（契约要求 < 0.30）
const PINCH_UP = 1.0;     // 空笔时 pinch 目标（契约要求 ≈ 1.0 且 > 0.70）
const PINCH_WOBBLE = 0.015; // pinch 的慢速起伏，让数据不像常量
const PINCH_RAMP_MS = 200;  // 落笔 / 提笔的捏合过渡时长（过渡帧不算"写字帧"）
const HOLD_MS = 1200;       // 一个字写完停 1.2 s（契约）
const SPEED = 0.0015;       // 笔尖 / 手掌移动速度：归一化单位 / 毫秒（engine.js:902：同字内 up→up ≤ 1100 ms，写太慢会把一个字拆散）
const MAX_STEP = 0.025;     // 单帧位移硬上限（虚拟时钟按 16.7 ms 步进 ⇒ 实际 ≈ 0.025）
const DT_CAP_MS = MAX_STEP / SPEED; // = 16.7 ms：虚拟时钟单帧最多前进这么多
const JITTER = 0.002;       // 轻微抖动振幅（±，每个 landmark 独立）
const JITTER_HZ = [1.7, 3.1]; // 两个不可通约的抖动频率，叠加后依然是平滑曲线
const BOW = 0.10;           // 拇指链的横向弯折（手掌跨度单位），纯造型
const PAD = 0.02;           // 安全边距：覆盖 2*JITTER(0.004) + 拇指弯折(~0.013)
const STEP_CAP = MAX_STEP + 4 * JITTER; // = 0.033：单帧位移断言上限（运动学 0.025 + 每帧抖动余量）
const DEG = 180 / Math.PI;

/* ------------------------------------------------------------- 小工具函数 --- */

function rotateDeg(v, deg) {
  const a = deg / DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/* --------------------------------------------------------------- 姿态构造 --- */

/**
 * 把一条手指链（mcp→pip→dip→tip）卷起来：每一节相对上一节旋转 CURL_DEG*(i-1)。
 * 弯曲方向不靠猜坐标系：两个方向都试，取"指尖离手腕更近"的那个 —— 确定性、
 * 且在任何坐标系约定下都自然。
 */
function curlChain(chain, wrist) {
  let best = null;
  for (const sign of [1, -1]) {
    const out = [{ x: chain[0].x, y: chain[0].y }];
    for (let i = 1; i < chain.length; i += 1) {
      const seg = { x: chain[i].x - chain[i - 1].x, y: chain[i].y - chain[i - 1].y };
      const r = rotateDeg(seg, sign * CURL_DEG * (i - 1));
      out.push({ x: out[i - 1].x + r.x, y: out[i - 1].y + r.y });
    }
    const tip = out[out.length - 1];
    const d = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
    if (!best || d < best.d) best = { d, out };
  }
  return best.out;
}

/** 写字姿态：手掌跨度 = 1，手腕在原点；只有食指伸直，其余三指卷起。 */
function buildWritePose() {
  const pts = REST_LANDMARKS.map(([x, y]) => ({ x: x / PALM_SPAN_REST, y: y / PALM_SPAN_REST }));
  const wrist = pts[0];
  for (const joints of CURLED_CHAINS) {
    const curled = curlChain(joints.map((i) => pts[i]), wrist);
    joints.forEach((idx, k) => { pts[idx] = curled[k]; });
  }
  return pts;
}

/**
 * 把局部姿态放到屏幕上：等比缩放 + 旋转 + 平移，且让 landmark 8（食指尖）
 * 精确落在 `tip`。等距变换保证 classifyHand 的比值型特征不变。
 */
function placePose(pose, theta, scale, tip) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const origin = pose[8];
  return pose.map((p) => {
    const dx = (p.x - origin.x) * scale;
    const dy = (p.y - origin.y) * scale;
    return { x: tip.x + dx * c - dy * s, y: tip.y + dx * s + dy * c, z: 0 };
  });
}

/** 平滑抖动，振幅 ≤ JITTER，且每帧变化极小（不会突破"单帧位移 ≤ STEP_CAP"）。 */
function jitterAt(seconds, index, axis) {
  const [f1, f2] = JITTER_HZ;
  const s =
    0.6 * Math.sin(2 * Math.PI * f1 * seconds + index * 1.3 + axis * 2.1) +
    0.4 * Math.sin(2 * Math.PI * f2 * seconds + index * 2.7 + axis * 1.1);
  return JITTER * s;
}

/**
 * 把拇指尖放到"距食指尖 = ratio × palmSpan"处，并据此重建拇指链。
 * 因为 measure() 的 pinch 就是这个距离除以 palmSpan，所以 pinch 精确 = ratio。
 * @param {Array<{x:number,y:number,z:number}>} screen 已就位的 21 点（就地修改）
 * @param {number} ratio 目标 pinch
 * @param {number} dirJitter 方向抖动（弧度）——只转方向，不改距离
 * @param {number} scale 手掌跨度（用于拇指弯折幅度）
 */
function forceThumbPinch(screen, ratio, dirJitter, scale) {
  const wrist = screen[0];
  const middleMcp = screen[9];
  const palmSpan = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y) || 1e-6;
  const tipIndex = screen[8];

  let ux = screen[4].x - tipIndex.x;
  let uy = screen[4].y - tipIndex.y;
  const n = Math.hypot(ux, uy) || 1e-6;
  ux /= n;
  uy /= n;
  const c = Math.cos(dirJitter);
  const s = Math.sin(dirJitter);
  const rx = ux * c - uy * s;
  const ry = ux * s + uy * c;

  const d = Math.max(0, ratio) * palmSpan;
  const target = { x: tipIndex.x + rx * d, y: tipIndex.y + ry * d, z: 0 };

  // 从拇指 cmc(L1) 到 target 重建 L2/L3，加一点侧向弯折让它不像一条直线
  const base = screen[1];
  const ax = target.x - base.x;
  const ay = target.y - base.y;
  const len = Math.hypot(ax, ay) || 1e-6;
  const px = -ay / len;
  const py = ax / len;
  const bow = BOW * scale;

  screen[4] = target;
  screen[3] = {
    x: base.x + ax * 0.72 + px * bow * 0.55,
    y: base.y + ay * 0.72 + py * bow * 0.55,
    z: 0,
  };
  screen[2] = {
    x: base.x + ax * 0.40 + px * bow,
    y: base.y + ay * 0.40 + py * bow,
    z: 0,
  };
}

/** 与 src/demo-frames.js 的 measure() 完全同构（字段名照抄，不要自创）。 */
function measure(screen, scale) {
  const wrist = screen[0];
  const middleMcp = screen[9];
  const palmSpan = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y) || PALM_SPAN_REST * scale;
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

/* --------------------------------------------------------------- 几何计算 --- */

/**
 * 选一个让"笔尖可用框"最大的旋转角，并给出字形映射用的正方形框。
 *
 * 推导：设相对笔尖的偏移集合为 O（含 (0,0)，因为笔尖自己也是一个屏幕点）。
 * 对任意一帧，第 i 个点 = 笔尖 + o_i，其中 |o_i - û_i| ≤ PAD（û_i 是模板偏移，
 * 误差来自抖动与拇指弯折）。要让所有点落在 0.15..0.85：
 *     笔尖.x ≥ 0.15 - min(o.x) + PAD   且   笔尖.x ≤ 0.85 - max(o.x) - PAD
 * 两个轴同理。把笔尖限制在这个矩形里，再取其中最大的正方形作为字形框，
 * 就得到"所有 21 点必然在 0.15..0.85"的充分条件（写成 selfTest 里的断言）。
 */
function computeGeometry(pose, scale) {
  const thetaStepDeg = 3;
  let best = null;

  for (let deg = 0; deg < 360; deg += thetaStepDeg) {
    const theta = deg / DEG;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const tip = pose[8];
    let exMin = Infinity;
    let exMax = -Infinity;
    let eyMin = Infinity;
    let eyMax = -Infinity;
    for (const p of pose) {
      const dx = (p.x - tip.x) * scale;
      const dy = (p.y - tip.y) * scale;
      const ox = dx * c - dy * s;
      const oy = dx * s + dy * c;
      if (ox < exMin) exMin = ox;
      if (ox > exMax) exMax = ox;
      if (oy < eyMin) eyMin = oy;
      if (oy > eyMax) eyMax = oy;
    }
    const txMin = 0.15 - exMin + PAD;
    const txMax = 0.85 - exMax - PAD;
    const tyMin = 0.15 - eyMin + PAD;
    const tyMax = 0.85 - eyMax - PAD;
    const w = txMax - txMin;
    const h = tyMax - tyMin;
    if (w <= 0 || h <= 0) continue;
    const side = Math.min(w, h);
    if (!best || side > best.side + 1e-12) {
      best = {
        theta,
        side,
        cx: (txMin + txMax) / 2,
        cy: (tyMin + tyMax) / 2,
        exMin,
        exMax,
        eyMin,
        eyMax,
      };
    }
  }

  if (!best) throw new Error('demo-glyph: handScale 太大，手放不进 0.15..0.85');

  const box = {
    x: best.cx - best.side / 2,
    y: best.cy - best.side / 2,
    w: best.side,
    h: best.side,
  };
  // 暂停时让整只手的包围盒居中在画面中央
  const centerOffset = {
    x: (best.exMin + best.exMax) / 2,
    y: (best.eyMin + best.eyMax) / 2,
  };
  return {
    theta: best.theta,
    box,
    pausedTip: { x: 0.5 - centerOffset.x, y: 0.5 - centerOffset.y },
    extents: { exMin: best.exMin, exMax: best.exMax, eyMin: best.eyMin, eyMax: best.eyMax },
  };
}

/* --------------------------------------------------------------- 轨迹构造 --- */

/** 字形坐标（0..1）→ 屏幕坐标 */
function toScreenStroke(points, box) {
  return points.map(([gx, gy]) => ({
    x: box.x + gx * box.w,
    y: box.y + gy * box.h,
  }));
}

/** 累积弧长表 */
function arcTable(poly) {
  const arcs = [0];
  for (let i = 1; i < poly.length; i += 1) {
    arcs.push(arcs[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
  }
  return arcs;
}

/** 取折线上弧长为 `target` 处的点 */
function pointAtArc(poly, arcs, target) {
  const total = arcs[arcs.length - 1];
  if (total <= 0) return { x: poly[0].x, y: poly[0].y };
  if (target <= 0) return { x: poly[0].x, y: poly[0].y };
  if (target >= total) return { x: poly[poly.length - 1].x, y: poly[poly.length - 1].y };
  let lo = 0;
  let hi = arcs.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (arcs[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = arcs[hi] - arcs[lo];
  const t = span > 1e-12 ? (target - arcs[lo]) / span : 0;
  return {
    x: poly[lo].x + (poly[hi].x - poly[lo].x) * t,
    y: poly[lo].y + (poly[hi].y - poly[lo].y) * t,
  };
}

/**
 * 造一个完整循环的动作时间线。
 * 顺序：每个字 → 逐笔 [捏合 settle → 写字 draw → 提笔 release → 走到下一笔] → 停 1.2 s
 *       → 走向下一个字的起笔点；最后一个字走回第一个字的起笔点，于是首尾相接，
 *       循环播放时位置连续、不会跳。
 */
function buildCycle(keys, box) {
  const keyStrokes = [];
  const keyNames = [];
  for (const key of keys) {
    const glyph = STROKES[key];
    if (!glyph || !glyph.length) continue;
    const strokes = glyph
      .map((stroke) => toScreenStroke(stroke, box))
      .filter((stroke) => stroke.length >= 2);
    if (!strokes.length) continue;
    keyStrokes.push(strokes.map((poly) => ({ poly, arcs: arcTable(poly) })));
    keyNames.push(key);
  }
  if (!keyStrokes.length) throw new Error(`demo-glyph: keys 里没有可用字形：${keys.join(',')}`);

  const segments = [];
  const counts = keyNames.map((_, k) =>
    keyStrokes[k].reduce((n, s, si) => n + 3 + (si + 1 < keyStrokes[k].length ? 1 : 0), 0) + 2,
  );

  function push(seg) {
    segments.push(seg);
  }

  for (let k = 0; k < keyStrokes.length; k += 1) {
    const strokes = keyStrokes[k];
    const total = keyStrokes.length;
    for (let s = 0; s < strokes.length; s += 1) {
      const { poly, arcs } = strokes[s];
      const len = arcs[arcs.length - 1];
      const start = poly[0];
      const end = poly[poly.length - 1];
      push({ kind: 'settle', dur: PINCH_RAMP_MS, point: start, key: k, stroke: s, keySeg: 0 });
      push({
        kind: 'draw',
        dur: Math.max(len / SPEED, 1),
        point: start,
        poly,
        arcs,
        total: len,
        key: k,
        stroke: s,
        keySeg: 0,
      });
      push({ kind: 'release', dur: PINCH_RAMP_MS, point: end, key: k, stroke: s, keySeg: 0 });
      // 同一字内还有下一笔时，提笔走过去；写完最后一笔则先停 1.2 s（见下面 hold）
      if (s + 1 < strokes.length) {
        const next = strokes[s + 1].poly[0];
        const dist = Math.hypot(next.x - end.x, next.y - end.y);
        push({
          kind: 'travel',
          dur: Math.max(dist / SPEED, 1),
          from: end,
          to: next,
          point: end,
          key: k,
          stroke: s,
          keySeg: 0,
        });
      }
    }
    const lastPoly = strokes[strokes.length - 1].poly;
    const lastPoint = lastPoly[lastPoly.length - 1];
    push({ kind: 'hold', dur: HOLD_MS, point: lastPoint, key: k, stroke: strokes.length - 1, keySeg: 0 });
    // 走向下一个字的起笔点（末尾这个字走回第一个字的起笔点 ⇒ 循环首尾相接，不跳）
    const nextKeyStart = keyStrokes[(k + 1) % keyStrokes.length][0].poly[0];
    const wrapDist = Math.hypot(nextKeyStart.x - lastPoint.x, nextKeyStart.y - lastPoint.y);
    push({
      kind: 'travel',
      dur: Math.max(wrapDist / SPEED, 1),
      from: lastPoint,
      to: nextKeyStart,
      point: lastPoint,
      key: k,
      stroke: strokes.length - 1,
      keySeg: 0,
    });
  }

  // 计算每段的起始时刻，并给每段标上"本字内第几段"（用于 progress 0..1）
  let t = 0;
  const seen = new Map();
  for (const seg of segments) {
    seg.start = t;
    t += seg.dur;
    const idx = seen.get(seg.key) ?? 0;
    seg.keySeg = idx;
    seg.keySegments = counts[seg.key] || 1;
    seen.set(seg.key, idx + 1);
  }

  return {
    segments,
    duration: t,
    startTip: keyStrokes[0][0].poly[0],
    keyNames,
  };
}

/* --------------------------------------------------------------- 自我描述 --- */

/** 最近一次 frames() 计算出的状态（给 describeGlyphDemo() 用）。 */
let lastDescription = {
  key: null,
  keyIndex: -1,
  strokeIndex: -1,
  strokeCount: 0,
  progress: 0,
  strokeProgress: 0,
  phase: 'idle',
  writing: false,
  paused: false,
  pinch: PINCH_UP,
  elapsedMs: 0,
  cycle: 0,
  tip: { x: 0.5, y: 0.5 },
};

/**
 * 返回"当前正在写哪个字、写到哪儿"，字段：
 * `{ key, keyIndex, strokeIndex, strokeCount, progress, strokeProgress, phase,
 *    writing, paused, pinch, elapsedMs, cycle, tip }`
 * `progress` 是**当前这个字**的完成度 0..1；`writing` 为 true 的帧就是
 * 契约里"写字时 pinch < 0.30"该被检查的帧。
 */
export function describeGlyphDemo() {
  return { ...lastDescription, tip: { ...lastDescription.tip } };
}

/* ------------------------------------------------------------------ 主体 --- */

/**
 * @param {object} [opts]
 * @param {string[]} [opts.keys] 要写的字，默认 ['A','5','H','I']
 * @param {number} [opts.handScale] 手掌跨度（归一化），默认 0.13
 * @param {boolean} [opts.paused] true 时输出"停在画面中央、pinch ≈ 1.0"的静止手
 * @param {number} [opts.startDelayMs] 开头静止多久再落笔，默认 600
 * @returns {Function} frames({ ts }) -> { hands: [hand] }（与 src/demo-frames.js 同构）
 */
export function createGlyphDemoFrames({
  keys = ['A', '5', 'H', 'I'],
  handScale = 0.13,
  paused = false,
  startDelayMs = 600,
} = {}) {
  const pose = buildWritePose();
  const geo = computeGeometry(pose, handScale);
  const cycle = buildCycle(keys, geo.box);

  let virtual = 0;      // 虚拟时钟（毫秒）：单帧最多前进 DT_CAP_MS
  let prevTs = null;
  let frameIndex = 0;
  let pausedNow = !!paused;

  function stateAt(v) {
    if (v < startDelayMs) {
      return {
        phase: 'idle',
        ratio: PINCH_UP,
        tip: cycle.startTip,
        keyIndex: 0,
        strokeIndex: -1,
        strokeCount: 0,
        progress: 0,
        strokeProgress: 0,
        cycleIndex: 0,
        seg: null,
      };
    }
    const local = v - startDelayMs;
    const cycleIndex = Math.floor(local / cycle.duration);
    const tc = local % cycle.duration;

    let seg = cycle.segments[cycle.segments.length - 1];
    for (const candidate of cycle.segments) {
      if (tc >= candidate.start && tc < candidate.start + candidate.dur) {
        seg = candidate;
        break;
      }
    }
    const elapsed = tc - seg.start;
    const frac = clamp01(seg.dur > 0 ? elapsed / seg.dur : 1);

    let phase = seg.kind;
    let ratio = PINCH_UP;
    let tip = seg.point ? { ...seg.point } : { x: 0.5, y: 0.5 };
    let strokeProgress = 0;

    if (seg.kind === 'travel') {
      tip = lerpPoint(seg.from, seg.to, frac);
    } else if (seg.kind === 'draw') {
      tip = pointAtArc(seg.poly, seg.arcs, frac * seg.total);
      strokeProgress = frac;
      ratio = PINCH_DOWN; // 写字全程捏紧（契约：写字帧 pinch < 0.30）
    } else if (seg.kind === 'settle') {
      ratio = PINCH_UP + (PINCH_DOWN - PINCH_UP) * frac;
    } else if (seg.kind === 'release') {
      ratio = PINCH_DOWN + (PINCH_UP - PINCH_DOWN) * frac;
    }

    const inside = new Map();
    return {
      phase,
      ratio,
      tip,
      keyIndex: seg.key,
      strokeIndex: seg.stroke,
      strokeCount: 0,
      progress: clamp01((seg.keySeg + frac) / (seg.keySegments || 1)),
      strokeProgress,
      cycleIndex,
      seg,
      inside,
    };
  }

  function buildHand(st, seconds) {
    const screen = placePose(pose, geo.theta, handScale, st.tip);
    for (let i = 0; i < screen.length; i += 1) {
      screen[i].x += jitterAt(seconds, i, 0);
      screen[i].y += jitterAt(seconds, i, 1);
      screen[i].z = 0;
    }
    const dirJitter = 0.12 * (jitterAt(seconds, 4, 2) / JITTER);
    const wobble = PINCH_WOBBLE * Math.sin(2 * Math.PI * 0.9 * seconds);
    const ratio = Math.max(0, st.ratio + wobble);
    forceThumbPinch(screen, ratio, dirJitter, handScale);
    return {
      index: 0,
      screen,
      world: pose.map((p) => ({
        x: p.x * 0.2 * handScale,
        y: -p.y * 0.2 * handScale,
        z: 0,
      })),
      label: 'Right',
      score: 0.99,
      ...measure(screen, handScale),
    };
  }

  /**
   * 每帧调用一次；`ts` 必须是单调递增的毫秒时间戳（rAF 的 performance.now
   * 或自检里的合成序列）。ts 不变/回退时按"重新开始"处理。
   */
  function frames({ ts } = {}) {
    const now = Number.isFinite(ts) ? ts : 0;
    let dt = prevTs === null ? 0 : now - prevTs;
    if (prevTs === null || dt < 0) {
      virtual = 0;
      dt = 0;
    }
    if (!pausedNow) virtual += Math.min(dt, DT_CAP_MS);
    prevTs = now;
    frameIndex += 1;

    const seconds = virtual / 1000;
    const st = stateAt(virtual);
    if (pausedNow) {
      // 暂停：手停在画面中央（整只手的包围盒居中），pinch ≈ 1.0，不产生笔迹
      st.phase = 'paused';
      st.ratio = PINCH_UP;
      st.tip = { ...geo.pausedTip };
      st.keyIndex = -1;
      st.strokeIndex = -1;
      st.progress = 0;
      st.strokeProgress = 0;
    }
    const hand = buildHand(st, seconds);
    const keyName = cycle.keyNames[st.keyIndex] ?? null;

    lastDescription = {
      key: keyName,
      keyIndex: st.keyIndex,
      strokeIndex: st.strokeIndex,
      strokeCount: st.seg ? st.seg.keySegments : 0,
      progress: st.progress,
      strokeProgress: st.strokeProgress,
      phase: pausedNow ? 'paused' : st.phase,
      writing: !pausedNow && st.phase === 'draw',
      paused: pausedNow,
      pinch: hand.pinch,
      elapsedMs: virtual,
      cycle: st.cycleIndex,
      tip: { x: hand.indexTip.x, y: hand.indexTip.y },
    };

    return { hands: [hand] };
  }

  /** 运行中切换暂停（保持字形进度，恢复后继续写）。 */
  frames.setPaused = (value) => {
    pausedNow = !!value;
  };
  /** 回到开头。 */
  frames.reset = () => {
    virtual = 0;
    prevTs = null;
    frameIndex = 0;
  };
  /** 当前状态，等价于全局 describeGlyphDemo()。 */
  frames.describe = describeGlyphDemo;
  frames.getPaused = () => pausedNow;
  frames.cycleDurationMs = cycle.duration + startDelayMs;
  frames.glyphBox = { ...geo.box };
  frames.handRotationDeg = (geo.theta * DEG) % 360;
  frames.keys = [...cycle.keyNames];
  frames.frameCount = () => frameIndex;
  return frames;
}

/* --------------------------------------------------------------- 自检断言 --- */

/**
 * 纯逻辑自检（不碰 DOM）：跑合成 ts 序列，检查契约第 4 节的硬性要求。
 * @returns {{ok:boolean, failures:string[], samples:object[], metrics:object, coverage:object}}
 */
export function selfTestGlyphDemo() {
  const failures = [];
  const samples = [];
  const step = 16.7;
  const EPS = 1e-9;

  const metrics = {
    maxPinchWhileWriting: -Infinity,
    minPinchWhileIdle: Infinity,
    minEdgeMargin: Infinity,
    maxTipStep: 0,
    maxPointStep: 0,
    gesturesWhileWriting: {},
    gesturesAll: {},
  };
  const coverage = { frames: 0, writing: 0, idle: 0, keysWritten: {}, phases: {} };

  function run(label, frames, durationMs) {
    frames.reset();
    let prev = null;
    const localMax = { pinchWriting: -Infinity, pinchIdle: Infinity, margin: Infinity, tipStep: 0, pointStep: 0 };
    const seenGestures = {};
    const writtenKeys = {};
    let writingFrames = 0;
    let idleFrames = 0;

    for (let ts = 0; ts <= durationMs + EPS; ts += step) {
      const { hands } = frames({ ts });
      const hand = hands[0];
      const desc = frames.describe();
      if (!hand) {
        failures.push(`${label} ts=${ts.toFixed(1)}: frames() 没有返回手`);
        continue;
      }
      coverage.frames += 1;
      if (desc.key) writtenKeys[desc.key] = (writtenKeys[desc.key] || 0) + 1;
      coverage.phases[desc.phase] = (coverage.phases[desc.phase] || 0) + 1;

      // --- 断言 A：21 个 screen 点都在 0.15..0.85 ---
      let frameMargin = Infinity;
      for (const p of hand.screen) {
        frameMargin = Math.min(frameMargin, p.x - 0.15, 0.85 - p.x, p.y - 0.15, 0.85 - p.y);
      }
      if (frameMargin < 0) {
        failures.push(
          `${label} ts=${ts.toFixed(1)}: 手部点越界，最小边距 ${frameMargin.toFixed(5)}（要求 ≥ 0）`,
        );
      }
      localMax.margin = Math.min(localMax.margin, frameMargin);
      metrics.minEdgeMargin = Math.min(metrics.minEdgeMargin, frameMargin);

      // --- 断言 B/C：写字 pinch < 0.30，空笔 pinch > 0.70 ---
      if (desc.writing) {
        writingFrames += 1;
        localMax.pinchWriting = Math.max(localMax.pinchWriting, hand.pinch);
        if (!(hand.pinch < 0.30)) {
          failures.push(
            `${label} ts=${ts.toFixed(1)} key=${desc.key} 写字帧 pinch=${hand.pinch.toFixed(4)}，要求 < 0.30`,
          );
        }
        const g = classifyHand(hand.screen).gesture;
        seenGestures[g] = (seenGestures[g] || 0) + 1;
        metrics.gesturesWhileWriting[g] = (metrics.gesturesWhileWriting[g] || 0) + 1;
        if (g === 'palm') {
          failures.push(
            `${label} ts=${ts.toFixed(1)} key=${desc.key}: 写字帧被 classifyHand 判成 'palm'（会让面板误开）`,
          );
        }
      } else if (desc.phase === 'idle' || desc.phase === 'hold' || desc.phase === 'travel' || desc.phase === 'paused') {
        idleFrames += 1;
        localMax.pinchIdle = Math.min(localMax.pinchIdle, hand.pinch);
        if (!(hand.pinch > 0.70)) {
          failures.push(
            `${label} ts=${ts.toFixed(1)} phase=${desc.phase} 空笔帧 pinch=${hand.pinch.toFixed(4)}，要求 > 0.70`,
          );
        }
      }
      const gAll = classifyHand(hand.screen).gesture;
      metrics.gesturesAll[gAll] = (metrics.gesturesAll[gAll] || 0) + 1;

      // --- 断言 D：单帧位移 ≤ MAX_STEP（0.025）---
      if (prev) {
        const tipStep = Math.hypot(hand.indexTip.x - prev.indexTip.x, hand.indexTip.y - prev.indexTip.y);
        let pointStep = 0;
        for (let i = 0; i < hand.screen.length; i += 1) {
          pointStep = Math.max(
            pointStep,
            Math.hypot(hand.screen[i].x - prev.screen[i].x, hand.screen[i].y - prev.screen[i].y),
          );
        }
        localMax.tipStep = Math.max(localMax.tipStep, tipStep);
        localMax.pointStep = Math.max(localMax.pointStep, pointStep);
        metrics.maxTipStep = Math.max(metrics.maxTipStep, tipStep);
        metrics.maxPointStep = Math.max(metrics.maxPointStep, pointStep);
        if (tipStep > STEP_CAP + EPS) {
          failures.push(`${label} ts=${ts.toFixed(1)}: 笔尖单帧位移 ${tipStep.toFixed(5)} > ${STEP_CAP.toFixed(3)}（瞬移）`);
        }
        if (pointStep > STEP_CAP + EPS) {
          failures.push(`${label} ts=${ts.toFixed(1)}: 手部点单帧位移 ${pointStep.toFixed(5)} > ${STEP_CAP.toFixed(3)}`);
        }
      }
      prev = hand;

      // 采样：每个字的第一个写字帧 + 第一个空笔帧
      if (desc.writing && !samples.some((s) => s.key === desc.key && s.writing)) {
        samples.push({
          ts: Number(ts.toFixed(1)),
          pass: label,
          key: desc.key,
          phase: desc.phase,
          writing: true,
          pinch: Number(hand.pinch.toFixed(4)),
          gesture: classifyHand(hand.screen).gesture,
          tip: { x: Number(hand.indexTip.x.toFixed(4)), y: Number(hand.indexTip.y.toFixed(4)) },
        });
      }
      if (!desc.writing && samples.filter((s) => !s.writing).length < 3 && coverage.frames % 3 === 0) {
        const already = samples.some((s) => !s.writing && s.phase === desc.phase);
        if (!already) {
          samples.push({
            ts: Number(ts.toFixed(1)),
            pass: label,
            key: desc.key,
            phase: desc.phase,
            writing: false,
            pinch: Number(hand.pinch.toFixed(4)),
            gesture: 'n/a',
            tip: { x: Number(hand.indexTip.x.toFixed(4)), y: Number(hand.indexTip.y.toFixed(4)) },
          });
        }
      }
    }

    coverage.writing += writingFrames;
    coverage.idle += idleFrames;
    for (const [k, v] of Object.entries(writtenKeys)) coverage.keysWritten[k] = (coverage.keysWritten[k] || 0) + v;
    metrics.maxPinchWhileWriting = Math.max(metrics.maxPinchWhileWriting, localMax.pinchWriting);
    metrics.minPinchWhileIdle = Math.min(metrics.minPinchWhileIdle, localMax.pinchIdle);

    return { label, writingFrames, idleFrames, ...localMax };
  }

  // 第一遍：任务书指定的 0..4000 ms 序列
  const shortFrames = createGlyphDemoFrames();
  const shortPass = run('短序列', shortFrames, 4000);

  // 第二遍：跑满整个循环（覆盖全部 4 个字和所有相位）
  const fullFrames = createGlyphDemoFrames();
  const fullPass = run('整周期', fullFrames, Math.ceil(fullFrames.cycleDurationMs) + 1200);

  // 覆盖率断言：四个字都应该被写到
  const expectKeys = ['A', '5', 'H', 'I'];
  for (const key of expectKeys) {
    if (!(coverage.keysWritten[key] > 0)) failures.push(`整周期里没有写到字形 '${key}'`);
  }
  if (coverage.writing === 0) failures.push('没有任何"写字帧"，演示手没有落笔');
  if (coverage.idle === 0) failures.push('没有任何"空笔帧"');

  // 暂停态：静止手 + pinch ≈ 1.0 + 不越界
  const pausedFrames = createGlyphDemoFrames({ paused: true });
  let pausedMinPinch = Infinity;
  let pausedMargin = Infinity;
  let pausedDrift = 0;
  let pausedPrevTip = null;
  for (let ts = 0; ts <= 1000 + EPS; ts += step) {
    const hand = pausedFrames({ ts }).hands[0];
    pausedMinPinch = Math.min(pausedMinPinch, hand.pinch);
    for (const p of hand.screen) {
      pausedMargin = Math.min(pausedMargin, p.x - 0.15, 0.85 - p.x, p.y - 0.15, 0.85 - p.y);
    }
    if (pausedPrevTip) {
      pausedDrift = Math.max(pausedDrift, Math.hypot(hand.indexTip.x - pausedPrevTip.x, hand.indexTip.y - pausedPrevTip.y));
    }
    pausedPrevTip = hand.indexTip;
  }
  if (!(pausedMinPinch > 0.70)) {
    failures.push(`暂停态 pinch 最小 ${pausedMinPinch.toFixed(4)}，要求 > 0.70（暂停时不该写字）`);
  }
  if (pausedMargin < 0) failures.push(`暂停态手部点越界，最小边距 ${pausedMargin.toFixed(5)}`);
  if (pausedDrift > 0.02) failures.push(`暂停态手在漂移，单帧位移 ${pausedDrift.toFixed(5)} > 0.02`);

  if (metrics.gesturesWhileWriting.palm) {
    failures.push(
      `写字帧里 classifyHand 给出 'palm' 共 ${metrics.gesturesWhileWriting.palm} 帧（需要手势层加防抖/门控）`,
    );
  }

  samples.push({
    ts: null,
    pass: '暂停态',
    key: null,
    phase: 'paused',
    writing: false,
    pinch: Number(pausedMinPinch.toFixed(4)),
    gesture: 'n/a',
    tip: { x: Number(pausedPrevTip.x.toFixed(4)), y: Number(pausedPrevTip.y.toFixed(4)) },
  });

  return {
    ok: failures.length === 0,
    failures,
    samples,
    metrics: {
      ...metrics,
      maxPinchWhileWriting: Number(metrics.maxPinchWhileWriting.toFixed(4)),
      minPinchWhileIdle: Number(metrics.minPinchWhileIdle.toFixed(4)),
      minEdgeMargin: Number(metrics.minEdgeMargin.toFixed(5)),
      maxTipStep: Number(metrics.maxTipStep.toFixed(5)),
      maxPointStep: Number(metrics.maxPointStep.toFixed(5)),
      pausedMinPinch: Number(pausedMinPinch.toFixed(4)),
      pausedMargin: Number(pausedMargin.toFixed(5)),
      shortPass,
      fullPass,
    },
    coverage: {
      ...coverage,
      keys: shortFrames.keys,
      glyphBox: shortFrames.glyphBox,
      handRotationDeg: shortFrames.handRotationDeg,
      cycleDurationMs: Math.round(shortFrames.cycleDurationMs),
    },
  };
}
