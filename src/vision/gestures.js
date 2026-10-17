/**
 * Gesture classification for a single MediaPipe hand.
 *
 * The classifier is deliberately geometric and dependency-free: it only reads
 * the 21 normalized landmarks and answers "which gesture is this, right now?".
 * A separate debouncer turns that per-frame answer into stable edges, so the
 * rest of the app can say `gesture.entered('palm')` instead of tracking timers.
 *
 * Gestures produced here (consumed by the air-writing UI):
 *   pen    — index extended, other three curled  -> write with the index tip
 *   palm   — open palm facing the camera         -> open the tool panel
 *   pinch  — thumb tip near index tip            -> select / confirm
 *   fist   — all four curled                     -> stop
 *   point  — index extended, other three relaxed -> move without drawing
 *   open   — several fingers extended, not a flat palm
 *   none   — no hand
 */

export const LANDMARK = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
};

/** [mcp, pip, tip] triples, in the MediaPipe landmark order. */
export const FINGERS = [
  { name: 'index', mcp: 5, pip: 6, dip: 7, tip: 8 },
  { name: 'middle', mcp: 9, pip: 10, dip: 11, tip: 12 },
  { name: 'ring', mcp: 13, pip: 14, dip: 15, tip: 16 },
  { name: 'pinky', mcp: 17, pip: 18, dip: 19, tip: 20 },
];

export const DEFAULTS = {
  /** PIP joint angle (degrees) at or above which a finger counts as extended. */
  extendAngle: 150,
  /** PIP joint angle at or below which a finger counts as curled. */
  curlAngle: 122,
  /** Wrist -> middle_mcp distance, as a fraction of the bbox diagonal. */
  palmWidthMin: 0.13,
  /** min(index spans) * max(index spans) / palm^2 above which a palm is "open". */
  flattenMax: 4.5,
  /** thumb tip / index tip distance (in palm widths) below which it is a pinch. */
  pinchDistance: 0.45,
  pinchRelease: 0.62,
  /** Milliseconds a pose must hold before `debounced` accepts / drops it. */
  acceptMs: 90,
  releaseMs: 130,
};

const DEG = 180 / Math.PI;

/**
 * Angle at joint `b` in the polyline a-b-c, in degrees (180 = perfectly straight).
 * Missing or degenerate points answer 180 so they never look "curled".
 */
export function jointAngle(a, b, c) {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return 180;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
  return Math.acos(cos) * DEG;
}

/** Scale reference that does not depend on hand distance or image size. */
export function handScale(landmarks) {
  const wrist = landmarks[LANDMARK.WRIST];
  const mid = landmarks[LANDMARK.MIDDLE_MCP];
  let size = Math.hypot(mid.x - wrist.x, mid.y - wrist.y);
  if (size < 1e-6) {
    // Degenerate pose (all points on top of each other): fall back to the
    // horizontal extent of the four knuckles.
    size = Math.hypot(
      landmarks[LANDMARK.INDEX_MCP].x - landmarks[LANDMARK.PINKY_MCP].x,
      landmarks[LANDMARK.INDEX_MCP].y - landmarks[LANDMARK.PINKY_MCP].y,
    );
  }
  return size;
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function palmCenter(landmarks) {
  return centroid([
    landmarks[LANDMARK.WRIST],
    landmarks[LANDMARK.INDEX_MCP],
    landmarks[LANDMARK.MIDDLE_MCP],
    landmarks[LANDMARK.RING_MCP],
    landmarks[LANDMARK.PINKY_MCP],
  ]);
}

/** Angle of the wrist -> middle knuckle axis, in degrees, y pointing down. */
export function palmAxis(landmarks) {
  const wrist = landmarks[LANDMARK.WRIST];
  const mid = landmarks[LANDMARK.MIDDLE_MCP];
  return Math.atan2(mid.y - wrist.y, mid.x - wrist.x) * DEG;
}

/**
 * 手掌朝向：'palm'（掌心朝镜头）/ 'back'（手背朝镜头）/ 'unknown'。
 *
 * 一张二维投影图**无法**只看几何判断正反手：把手翻过来，投影片就是镜像，长度、
 * 关节角、捏合距离全都一模一样（这也是为什么"张开手掌"两个朝向都能被判成 palm）。
 * 唯一能拆开这对镜像的信息是 handedness 标签：它由模型给出，和 2D 手性
 * （wrist→index_mcp 与 wrist→pinky_mcp 的叉积符号）**是否一致**决定正反。
 *
 * MediaPipe 的标签建立在"输入是自拍镜像"的假设上，所以调用方必须声明坐标是否
 * 已经镜像过（`mirrored`）。默认 true = 与 app.js 的镜像预览一致：
 * 右手掌心朝镜头时叉积为正。
 *
 * @param {Array<{x:number,y:number}>} landmarks 21 points
 * @param {{handedness?:string, mirrored?:boolean}} [options]
 */
export function handFacing(landmarks, options = {}) {
  const handedness = options.handedness;
  if (handedness !== 'Left' && handedness !== 'Right') return 'unknown';
  const mirrored = options.mirrored !== false;
  const wrist = landmarks[LANDMARK.WRIST];
  const indexMcp = landmarks[LANDMARK.INDEX_MCP];
  const pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
  const cross =
    (indexMcp.x - wrist.x) * (pinkyMcp.y - wrist.y) -
    (indexMcp.y - wrist.y) * (pinkyMcp.x - wrist.x);
  // 手掌摊平时叉积约 0.8 palm²；退化成一条线时不敢下结论。
  if (Math.abs(cross) < 1e-4) return 'unknown';
  const palmSide = mirrored ? cross > 0 : cross < 0;
  return palmSide === (handedness === 'Right') ? 'palm' : 'back';
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Classify one hand as it appears in a single frame.
 *
 * @param {Array<{x:number,y:number,z?:number}>} landmarks 21 normalized points
 * @param {object} [options] overrides for DEFAULTS
 * @returns {object} classification (never null for a valid hand)
 */
export function classifyHand(landmarks, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const scale = handScale(landmarks) || 1e-6;
  const wrist = landmarks[LANDMARK.WRIST];

  const joints = [];
  const fingers = {};
  for (const finger of FINGERS) {
    const mcp = landmarks[finger.mcp];
    const pip = landmarks[finger.pip];
    const dip = landmarks[finger.dip];
    const tip = landmarks[finger.tip];
    const angle = jointAngle(mcp, pip, tip);
    const dipAngle = jointAngle(pip, dip, tip);
    // Curl direction: is the tip farther from the wrist than the pip joint?
    const radiusGain = (distance(tip, wrist) - distance(pip, wrist)) / scale;
    const extended = angle >= cfg.extendAngle && radiusGain > -0.08;
    const curled = angle <= cfg.curlAngle || radiusGain < -0.22;
    fingers[finger.name] = {
      angle,
      dipAngle,
      radiusGain,
      extended,
      curled,
      tip,
      pip,
      mcp,
    };
    joints.push(Math.min(angle, dipAngle));
  }

  const indexSpan = distance(landmarks[LANDMARK.INDEX_TIP], landmarks[LANDMARK.INDEX_MCP]) / scale;
  const middleSpan = distance(landmarks[LANDMARK.MIDDLE_TIP], landmarks[LANDMARK.MIDDLE_MCP]) / scale;
  const ringSpan = distance(landmarks[LANDMARK.RING_TIP], landmarks[LANDMARK.RING_MCP]) / scale;
  const pinkySpan = distance(landmarks[LANDMARK.PINKY_TIP], landmarks[LANDMARK.PINKY_MCP]) / scale;
  const spans = [indexSpan, middleSpan, ringSpan, pinkySpan];
  // A flat, camera-facing palm has every finger spread out and fully extended.
  const openness = (Math.min(...spans) * Math.max(...spans)) / (scale * scale);
  const avgJoint = joints.reduce((a, b) => a + b, 0) / joints.length;

  const palmWidth = distance(landmarks[LANDMARK.INDEX_MCP], landmarks[LANDMARK.PINKY_MCP]) / scale;
  const indexExtended = fingers.index.extended;
  const othersCurled = fingers.middle.curled && fingers.ring.curled && fingers.pinky.curled;
  // 四指都伸直（不含拇指）：手背和掌心朝镜头都可能满足，所以只说明"平手"，
  // 不说明正反；正反由 facing 给出。
  const fourExtended =
    indexExtended &&
    fingers.middle.extended &&
    fingers.ring.extended &&
    fingers.pinky.extended;
  const thumbTip = landmarks[LANDMARK.THUMB_TIP];
  const indexTip = landmarks[LANDMARK.INDEX_TIP];
  const pinchDistance = distance(thumbTip, indexTip) / scale;

  const allCurled =
    fingers.index.curled && fingers.middle.curled && fingers.ring.curled && fingers.pinky.curled;
  const flatPalm =
    fourExtended &&
    openness >= cfg.flattenMax &&
    avgJoint >= cfg.extendAngle - 24 &&
    palmWidth >= cfg.palmWidthMin;

  let gesture = 'open';
  if (flatPalm) {
    gesture = 'palm';
  } else if (allCurled) {
    gesture = 'fist';
  } else if (indexExtended && othersCurled) {
    gesture = 'pen';
  } else if (indexExtended && !fingers.middle.extended && !fingers.ring.extended) {
    gesture = 'point';
  }

  return {
    gesture,
    pinch: pinchDistance,
    pinchDistance,
    scale,
    palmWidth,
    openness,
    avgJoint,
    fourExtended,
    // 'palm' | 'back' | 'unknown' —— 掌心/手背朝向，需要 handedness 才能定
    facing: handFacing(landmarks, { handedness: cfg.handedness, mirrored: cfg.mirrored }),
    fingers,
    joints,
    wrist: landmarks[LANDMARK.WRIST],
    indexTip,
    thumbTip,
    middleTip: landmarks[LANDMARK.MIDDLE_TIP],
    palmCenter: palmCenter(landmarks),
    palmAxis: palmAxis(landmarks),
    extendedCount: spans.filter((s) => s > 0.9).length,
  };
}

/** A stable value that only changes after the candidate has held for a while. */
class StableFlag {
  constructor(acceptMs, releaseMs, initial = false) {
    this.acceptMs = acceptMs;
    this.releaseMs = releaseMs;
    this.value = initial;
    this.since = 0;
    this.candidate = initial;
  }

  update(next, now) {
    if (next !== this.candidate) {
      this.candidate = next;
      this.since = now;
    }
    const held = now - this.since;
    if (this.candidate !== this.value) {
      const needed = this.candidate ? this.acceptMs : this.releaseMs;
      if (held >= needed) this.value = this.candidate;
    }
    return this.value;
  }

  reset(value = false) {
    this.value = value;
    this.candidate = value;
    this.since = 0;
  }
}

/**
 * Stroke-level gesture tracker: one instance per tracked hand.
 *
 * `update()` returns `{active, entered, left, held}` for every known gesture,
 * plus the raw classification. Use `entered('pen')` to start a stroke and
 * `left('pen')` to finish one.
 */
export class GestureTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    const { acceptMs, releaseMs } = this.options;
    this.handlers = new Map();
    this.names = ['pen', 'palm', 'pinch', 'fist', 'point', 'open'];
    for (const name of this.names) {
      this.handlers.set(name, new StableFlag(acceptMs, releaseMs));
    }
    this.pinchFlag = new StableFlag(acceptMs, releaseMs);
    this.classification = null;
    this.gesture = 'none';
    this.since = 0;
  }

  /** True once the *stable* gesture has been `name` continuously. */
  is(name) {
    return this.handlers.get(name)?.value === true;
  }

  update(landmarks, now = performance.now(), handedness = null) {
    const previous = this.gesture;
    if (!landmarks || landmarks.length < 21) {
      for (const flag of this.handlers.values()) flag.update(false, now);
      this.gesture = 'none';
      this.classification = null;
      return {
        gesture: 'none',
        active: 'none',
        previous,
        entered: () => false,
        left: () => false,
        classification: null,
      };
    }

    const classification = classifyHand(landmarks, this.options);
    this.classification = classification;
    const flags = {};
    for (const name of this.names) {
      const flag = this.handlers.get(name);
      flags[name] = flag.update(classification.gesture === name, now);
    }
    // Pinch is orthogonal to the pose gesture, and needs hysteresis so the
    // hold/click does not chatter.
    const pinching = classification.pinch <= (this.pinchFlag.value
      ? this.options.pinchRelease
      : this.options.pinchDistance);
    flags.pinch = this.pinchFlag.update(pinching, now);

    let dominant = 'open';
    for (const name of ['palm', 'pen', 'pinch', 'fist', 'point']) {
      if (flags[name]) {
        dominant = name;
        break;
      }
    }
    if (dominant !== this.gesture) {
      this.gesture = dominant;
      this.since = now;
    }

    return {
      gesture: dominant,
      active: dominant,
      previous,
      held: now - this.since,
      entered: (name) => previous !== name && dominant === name,
      left: (name) => previous === name && dominant !== name,
      classification,
      handedness,
      flags,
    };
  }

  reset() {
    for (const flag of this.handlers.values()) flag.reset(false);
    this.pinchFlag.reset(false);
    this.gesture = 'none';
    this.classification = null;
  }
}

/**
 * Convenience factory used by the air-writing pipeline.
 * `hysteresis` is exposed so tests can trade latency for stability.
 */
export function createGestureClassifier(options = {}) {
  return {
    options: { ...DEFAULTS, ...options },
    trackers: new Map(),

    /** Track one hand by key (e.g. 'Left'/'Right'), creating its tracker lazily. */
    track(key, landmarks, now, handedness) {
      let tracker = this.trackers.get(key);
      if (!tracker) {
        tracker = new GestureTracker(this.options);
        this.trackers.set(key, tracker);
      }
      return tracker.update(landmarks, now, handedness);
    },

    /** Drop trackers for hands that vanished this frame. */
    prune(liveKeys) {
      for (const key of [...this.trackers.keys()]) {
        if (!liveKeys.has(key)) this.trackers.get(key).reset();
      }
    },

    classify: classifyHand,
    reset() {
      for (const tracker of this.trackers.values()) tracker.reset();
    },
  };
}
