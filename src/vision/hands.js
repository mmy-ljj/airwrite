/**
 * Hand feature tracker: 21 landmarks per hand, world + normalized coordinates,
 * plus optional handedness. Mirrors MediaPipe's own HandLandmarker wiring so
 * that swapping to another task only means writing another tracker.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { resolveModel, resolveWasmPath } from '../assets.js';
import { OneEuroPointFilter } from './smoothing.js';

/** MediaPipe hand skeleton, as index pairs into the 21 landmarks. */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring
  [13, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [0, 17],                                   // palm
];

/** Tip / pip landmark ids per finger, used by gestures and by "active point" logic. */
export const FINGERS = {
  thumb: { tip: 4, pip: 3, mcp: 2 },
  index: { tip: 8, pip: 6, mcp: 5 },
  middle: { tip: 12, pip: 10, mcp: 9 },
  ring: { tip: 16, pip: 14, mcp: 13 },
  pinky: { tip: 20, pip: 18, mcp: 17 },
};

/**
 * MediaPipe 的 handedness 是按"自拍镜像"约定给出的（它假设输入图像已经左右翻转，
 * 就像照镜子）。这里的模型输入是**未镜像**的原始 <video>（预览的镜像只是 CSS
 * transform，见 app.js 的 stage.mirror），所以模型报出来的左右手恒为真实值的
 * 镜像 —— 必须翻一次。rig.js 顶部注释一直声称在 adaptResult 里换过，但那段代码
 * 从来没写过，于是画面角标一直把右手写成左手。
 *
 * 左右手标签不只是显示问题：二维投影下"右手掌心"和"左手手背"是同一张图，
 * 掌心/手背只能靠 handedness 来拆，标签一错，手背滑动的判定就整个反过来。
 */
function flipHand(label) {
  if (label === 'Left') return 'Right';
  if (label === 'Right') return 'Left';
  return label;
}

export function createHandsTracker({
  numHands = 2,
  minDetectionConfidence = 0.6,
  minTrackingConfidence = 0.6,
  smoothing = true,
  /**
   * 是否把 handedness 翻成"真实左右手"。仅当有人把镜像后的画布喂给模型
   * （而不是原始 <video>）时才该关掉；改这里必须同步 app.js 的坐标镜像。
   */
  flipHandedness = true,
  /**
   * 'GPU' 快，但部分手机浏览器（尤其是 iOS Safari 的 WebGL 限制）创建
   * landmarker 时会直接失败 —— 这时自动回退 'CPU'，慢一些但一定能跑。
   * 传 'CPU' 可跳过尝试。
   */
  delegate = 'GPU',
} = {}) {
  let landmarker = null;
  /** 实际生效的 delegate（init 之后才知道），快照/排查用。 */
  let activeDelegate = null;
  /** Smoothers keyed by "handIndex:landmarkIndex" (world + screen sets). */
  const screenFilters = new Map();
  const worldFilters = new Map();
  let lastVideoTime = -1;

  function filterFor(map, key, alphaHz) {
    let f = map.get(key);
    if (!f) {
      f = new OneEuroPointFilter({ minCutoff: 1.2, beta: 0.02, derivateCutoff: 1.0 });
      map.set(key, f);
    }
    return f;
  }

  return {
    id: 'hands',

    /** 实际生效的 delegate（init 之后才有值），排查手机性能用。 */
    get delegate() {
      return activeDelegate;
    },

    async init() {
      const wasmPath = await resolveWasmPath();
      const vision = await FilesetResolver.forVisionTasks(wasmPath);
      const { url } = await resolveModel('hand_landmarker');
      const build = (device) => ({
        baseOptions: { modelAssetPath: url, delegate: device },
        runningMode: 'VIDEO',
        numHands,
        minHandDetectionConfidence: minDetectionConfidence,
        minHandPresenceConfidence: minDetectionConfidence,
        minTrackingConfidence: minTrackingConfidence,
      });
      // GPU 快，但手机浏览器可能创建失败（WebGL 限制/显存不足）→ 退 CPU。
      const order = delegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
      let lastErr = null;
      for (const device of order) {
        try {
          landmarker = await HandLandmarker.createFromOptions(vision, build(device));
          activeDelegate = device;
          return;
        } catch (err) {
          lastErr = err;
          landmarker = null;
        }
      }
      throw lastErr || new Error('hand landmarker failed to initialise');
    },

    detect(video, ts) {
      if (!landmarker) return null;
      // Re-running the model on the same decoded frame is wasted work.
      if (video.currentTime === lastVideoTime) return { reused: true };
      lastVideoTime = video.currentTime;
      return landmarker.detectForVideo(video, ts);
    },

    adapt(raw) {
      if (!raw || raw.reused) return null;
      const out = [];
      const hands = raw.landmarks || [];
      const worlds = raw.worldLandmarks || [];
      const handed = raw.handedness || raw.handednesses || [];

      for (let i = 0; i < hands.length; i += 1) {
        const screen = hands[i].map((p, j) => {
          if (!smoothing) return { x: p.x, y: p.y, z: p.z };
          const f = filterFor(screenFilters, `${i}:${j}`);
          const s = f.filter(p.x, p.y, p.z, raw.ts ?? performance.now());
          return { x: s.x, y: s.y, z: s.z };
        });
        const world = (worlds[i] || []).map((p, j) => {
          if (!smoothing) return { x: p.x, y: p.y, z: p.z };
          const f = filterFor(worldFilters, `${i}:${j}`);
          const s = f.filter(p.x, p.y, p.z, raw.ts ?? performance.now());
          return { x: s.x, y: s.y, z: s.z };
        });
        const seenLabel = handed[i]?.[0]?.categoryName ?? `hand${i}`;
        const label = flipHandedness ? flipHand(seenLabel) : seenLabel;
        const score = handed[i]?.[0]?.score ?? 0;
        out.push({
          index: i,
          screen,      // normalized [0,1] in video space
          world,       // meters, origin at the hand's approximate geometric center
          label,       // 真实左右手（MediaPipe 原始标签已按未镜像输入翻转）
          score,
          ...measureHand(screen, world),
        });
      }
      return out;
    },

    dispose() {
      landmarker?.close();
      landmarker = null;
    },
  };
}

/** Cheap derived measurements that effects and gestures both keep needing. */
function measureHand(screen, world) {
  const wrist = screen[0];
  const middleMcp = screen[9];
  const palmSpan = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y) || 1e-6;
  const pinch = Math.hypot(screen[4].x - screen[8].x, screen[4].y - screen[8].y) / palmSpan;
  const indexTip = screen[8];
  const thumbTip = screen[4];
  return {
    wrist,
    palmCenter: {
      x: (wrist.x + middleMcp.x + screen[5].x + screen[17].x) / 4,
      y: (wrist.y + middleMcp.y + screen[5].y + screen[17].y) / 4,
      z: (wrist.z + middleMcp.z + screen[5].z + screen[17].z) / 4,
    },
    indexTip,
    thumbTip,
    /** pinch distance normalized by palm width: ~<0.35 means touching. */
    pinch,
    /** normalized 3D palm size, a proxy for distance from the camera. */
    scale: palmSpan,
    worldScale: Math.hypot(
      (world[9]?.x ?? 0) - (world[0]?.x ?? 0),
      (world[9]?.y ?? 0) - (world[0]?.y ?? 0),
      (world[9]?.z ?? 0) - (world[0]?.z ?? 0),
    ),
  };
}
