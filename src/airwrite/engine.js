/**
 * AirWrite 引擎：把"手"翻译成"字"。
 *
 * 这一层不碰 DOM、不碰 canvas、不认识 MediaPipe，只做三件事：
 *   1. 手势状态机 —— 捏合落笔（m00390）、张开手掌开关工具面板（m00209 / m00304）、
 *      食指悬停选择（m00228）、拇指食指开合缩放（m00430）；
 *   2. 把落笔的点喂给 ink.js 记录成笔迹，并按"停顿分字"把笔迹切成一个字符；
 *   3. 维护"手掌向右横扫 => 像雪花一样飘散"的特效状态（m00477）。
 *
 * 所有几何都是**归一化视频坐标**（x、y ∈ 0..1，左上原点），
 * 只有"橡皮擦半径 / 最短笔长"这类尺寸在传入 pixelScale 后按 CSS 像素解释。
 *
 * 事件：on('stroke'|'erase'|'character'|'tool'|'selection'|'settle'|'status', fn)
 */

import { createInkRecorder } from './ink.js';
import { hitTest, layoutPanel } from './panel-layout.js';
import { classifyHand } from '../vision/gestures.js';

const TAU = Math.PI * 2;
let particleSeq = 0;

export const DEFAULT_CONFIG = {
  // 捏合阈值（拇指尖-食指尖距离 / 手掌尺度）
  pinchStart: 0.42,
  pinchEnd: 0.6,
  pinchSmooth: 0.35,
  // 笔迹过滤
  minSampleDistance: 0.0016,
  minStrokeLength: 0.004,
  // 分字
  characterGapMs: 1100,
  doublePinchMs: 420,
  maxStrokesPerCharacter: 8,
  /*
   * 分字精修（m02798）：光看停顿一个信号不够。
   * 慢写的多笔字（H / A / 我）会被 1.1 秒切成一笔一个字，快写的两个字又会被并起来。
   * 补两个信号：提笔后手有没有走开、这一笔落得离上一字远不远；组合规则见 ink.js。
   */
  resumeGapMs: 2600,
  /*
   * 提笔后手平移多远算"人已经离开这块书写区"：跟着字的大小缩放（1.25 个字），
   * 但至少 0.22 个画面。这个阈值管的是"挪到别处继续写"，不是"换下一个字"——
   * 换字主要靠停顿（gapMs）和"起笔离上一笔很远"（near 判定），因为一个字的
   * 第 2、3 笔同样要抬笔挪手，位移和换字几乎一样大，靠位移分不开。
   */
  travelBreakFrac: 1.25,
  travelBreakDistance: 0.22,
  resumeMarginMin: 0.05,
  resumeMarginFrac: 0.55,
  // 提笔迟滞：捏合松开要稳定保持这么久才收笔（消掉单帧抖动切笔）
  penUpHoldMs: 90,
  penUpCancel: 0.5,
  /*
   * 追踪跳变的"隐含速度"闸：单帧位移只要有 glitchMinDistance 这么大，而且比这一笔
   * 自己的近期速度（EMA）快 glitchSpeedFactor 倍以上，就当 landmark 甩了、直接丢样。
   * glitchMinSpeed 是下限，别低于正常快写的速度 —— 正常快写每帧 0.03~0.05（2~4 单位/秒），
   * 取 6 单位/秒留足余量；设成 1.2 会把正常笔迹也丢掉。
   */
  glitchSpeedFactor: 4.5,
  glitchMinSpeed: 6,
  glitchMinDistance: 0.05,
  glitchMaxGapMs: 320,
  // 面板
  dwellMs: 700,
  // 张开手掌开面板：累计满足 palm 的时长（允许抖动间隙），不再是"连续若干帧"
  palmHoldMs: 90,
  palmGapMs: 260,
  // 一次"张开手掌"只开关一次；这只手离开 palm 姿态超过这么久才重新武装
  palmLatchReleaseMs: 80,
  // 手势稳健性：丢帧宽限 / 刚提笔冷却 / 散字姿态需持续
  handGraceMs: 150,
  drawCooldownMs: 320,
  dissolveHoldMs: 140,
  // 缩放（m00430）
  zoomMin: 0.4,
  zoomMax: 3.2,
  zoomBaseSpan: 0.45,
  // 雪花飘散（m00477；m02869 精修 + 改为手背右滑触发）
  snowWindowMs: 420,
  snowMinTravel: 0.16,
  snowMaxDrift: 0.12,
  // 结晶停留 → 抬起 → 飘落，三段分开，散开的形状先看得清再化掉
  snowCrackMs: 150,
  snowHoldMs: 1200,
  snowFadeMs: 1800,
  snowRiseMs: 260,
  snowMaxParticles: 4200,
  // 碎屑更细：步长 7px，保证小字也能散成"雪"而不是几条粗线
  snowStepPx: 7,
  snowGustX: 0.05,
  snowTwinkleFraction: 0.18,
};

export const PALETTE = ['#6ee7ff', '#ff6ec7', '#ffe76e', '#7cffa0', '#ffffff', '#ff8a5c'];
export const PEN_SIZES = [6, 10, 16];
export const ERASER_SIZES = [26, 40];
export const TOOL_LABELS = { pen: '笔', eraser: '橡皮擦', zoom: '缩放' };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ------------------------------------------------------------------ 手势几何 */

/** 手掌尺度：手腕→中指根，退化时退回四指根跨度。 */
function handSpan(landmarks) {
  const wrist = landmarks[0];
  const mid = landmarks[9];
  let size = distance(wrist, mid);
  if (size < 1e-6) size = distance(landmarks[5], landmarks[17]);
  if (size < 1e-6) size = distance(landmarks[5], landmarks[9]);
  return size || 1e-6;
}

/** 手指尖相对同一 MCP 的半径增益（< 0 表示指尖收回到手掌里）。 */
function radialGain(tip, mcp, wrist, scale) {
  return (distance(tip, wrist) - distance(mcp, wrist)) / scale;
}

/**
 * 从 21 个关键点算出引擎真正需要的那几个量。
 * 刻意只用几何量：合成手、摄像头、鼠标兜底都能走同一条路。
 *
 * @param {Array<{x:number,y:number,z?:number}>} landmarks 21 normalized points
 * @param {{handedness?:string, mirrored?:boolean}} [options] 判"掌心/手背"需要
 *   handedness 标签 + 坐标是否已镜像（详见 gestures.js 的 handFacing）
 */
export function handMetrics(landmarks, options = {}) {
  if (!landmarks || landmarks.length < 21) return null;
  const scale = handSpan(landmarks);
  const wrist = landmarks[0];
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const pinch = distance(thumbTip, indexTip) / scale;

  const gains = [];
  for (const [tipIndex, mcpIndex] of [
    [8, 5],
    [12, 9],
    [16, 13],
    [20, 17],
  ]) {
    gains.push(radialGain(landmarks[tipIndex], landmarks[mcpIndex], wrist, scale));
  }
  const [gIndex, gMiddle, gRing, gPinky] = gains;
  const curled = (g) => g < -0.06;

  const palmCenter = {
    x: (landmarks[0].x + landmarks[5].x + landmarks[9].x + landmarks[13].x + landmarks[17].x) / 5,
    y: (landmarks[0].y + landmarks[5].y + landmarks[9].y + landmarks[13].y + landmarks[17].y) / 5,
  };

  const classification = classifyHand(landmarks, {
    handedness: options.handedness,
    mirrored: options.mirrored,
  });
  const kind = classification.gesture;

  /*
   * 张开手掌：直接采用 gestures.js 的 'palm' 判定，再要求拇指与食指分开
   * （张开的手掌不该是捏着的）。
   *
   * 曾经这里用自己的一套"四指半径增益 > 0.2"阈值，那个阈值宽松到灾难：
   * 手只张开 30%（拇指稍微离开食指、其余三指还蜷着）就被判成 palm，
   * 于是"松手提笔"会立刻被当成"张开手掌"，面板乱弹、横扫也会误触发。
   * 实测一张完全张开的手掌增益在 1.0 以上，而 0.2 的门槛几乎等于没有门槛。
   */
  const palm = kind === 'palm' && pinch > 0.5;

  return {
    landmarks,
    scale,
    wrist,
    thumbTip,
    indexTip,
    middleTip: landmarks[12],
    pinch,
    pinchMid: { x: (thumbTip.x + indexTip.x) / 2, y: (thumbTip.y + indexTip.y) / 2 },
    palmCenter,
    gains: { index: gIndex, middle: gMiddle, ring: gRing, pinky: gPinky },
    palm,
    // 四指伸直（可能是掌心也可能是手背，用于"手背右滑"的姿态门槛）
    flat: classification.fourExtended,
    // 'palm' | 'back' | 'unknown'
    palmFacing: classification.facing,
    curled: curled(gIndex) && curled(gMiddle) && curled(gRing) && curled(gPinky),
    kind,
  };
}

/**
 * 散字动作的姿态门槛：手背朝镜头右滑，或一张没张到"面板手掌"程度的平手右滑。
 *
 * 为什么不直接要求 metrics.palm：手掌张开是**面板**的开关手势，用户要的散字
 * 手势是"手背右滑"，两者必须区分开。palm = 严格的"四指张开 + 掌心摊平"，
 * 手背朝镜头时 facing 直接给出答案；剩下"伸直但没摊平"的手（比如摄像头下
 * 手指并拢、或掌心判定被镜像/光照干扰）继续沿用旧的右滑兜底，保证手势可用。
 */
function isDissolvePose(metrics) {
  if (!metrics) return false;
  if (metrics.palmFacing === 'back') return true;
  return !!metrics.flat && !metrics.palm;
}

/** 滑块平滑：pinch 抖动会让笔断断续续，先平滑再判阈值。 */
function smooth(previous, next, alpha) {
  if (!Number.isFinite(previous)) return next;
  return previous + (next - previous) * alpha;
}

/* ------------------------------------------------------------------- 工厂函数 */

export function createAirWriteEngine(options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const recognizer = options.recognizer || null;
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const nowImpl = options.now || clock;

  /* 记录器：坐标空间就是归一化视频坐标，尺寸按 pixelScale 折算。 */
  const ink = createInkRecorder({
    minSampleDistance: cfg.minSampleDistance,
    minStrokeLength: cfg.minStrokeLength,
    gapMs: cfg.characterGapMs,
    maxStrokes: cfg.maxStrokesPerCharacter,
    maxExtent: 0.9,
    maxSamplesPerStroke: 1400,
    maxCharacters: 60,
    // 分字的多信号配置（m02798）：停顿 + 提笔后手走开多远 + 落笔是否在上一字旁边。
    resumeGapMs: cfg.resumeGapMs,
    travelBreakFrac: cfg.travelBreakFrac,
    travelBreakDistance: cfg.travelBreakDistance,
    resumeMarginMin: cfg.resumeMarginMin,
    resumeMarginFrac: cfg.resumeMarginFrac,
    glitchSpeedFactor: cfg.glitchSpeedFactor,
    glitchMinSpeed: cfg.glitchMinSpeed,
    glitchMinDistance: cfg.glitchMinDistance,
    glitchMaxGapMs: cfg.glitchMaxGapMs,
  });

  /*
   * 分字关闭的唯一出口。ink 每关闭一个字符就同步发 'character'（无论关闭发生在
   * tick 里还是 begin 里），引擎在这里把它接管成自己的字符；'revoke' 是 ink 发现
   * 自己过早交字、把笔迹收回继续合并时发出的，用来把那个"半个字"撤掉。
   */
  ink.on('character', (character) => {
    adoptInkCharacter(character);
  });
  ink.on('revoke', (character) => {
    revokeCharacter(character.strokes);
  });

  /* ---------------- 状态 ---------------- */

  const saved = readSavedStyle();

  const state = {
    palette: [...PALETTE],
    tool: saved.tool,
    color: saved.color,
    size: saved.size,
    eraserSize: saved.eraserSize,
    selectionMode: false,
    panelAnchor: { x: 0.5, y: 0.5 },
    panelOpenedAt: 0,
    cursor: { x: 0.5, y: 0.5, active: false, pinch: 1 },
    drawing: false,
    toolChangedAt: 0,
    zoom: {
      level: 1,
      panX: 0,
      panY: 0,
      active: false,
      span: 1,
      spanAtEntry: 1,
      levelAtEntry: 1,
    },
  };

  const selection = {
    active: false,
    anchor: { x: 0.5, y: 0.5 },
    openedAt: 0,
    item: null,
    itemSince: 0,
    hit: null,
    flash: null,
  };

  const characters = [];
  let charactersSeq = 0;
  let lastPenDownAt = 0;
  let lastCloseAt = 0;
  let closedReason = 'gap';
  let inkVersion = 1;
  let pixelScale = 1000;
  let aspect = 16 / 9;
  /*
   * 面板画在"画布归一化坐标系"里（render.js 用 x*width / y*height 直接画），
   * 而光标来自 landmarks，是"视频归一化坐标系"。两者在 cover 裁剪下并不等价
   * （4:3 摄像头放进 16:9 视口时纵向差很多），所以命中测试前必须把光标投影到
   * 画布像素再归一化。渲染层通过 setViewport({ project, canvasWidth, canvasHeight })
   * 把投影函数交进来；没有投影函数时退化为恒等映射（适配裁剪比为 1 的场合）。
   */
  let projector = null;
  const canvasSize = { x: 0, y: 0 };
  let panel = layoutPanel({ aspect });
  let panelSig = '';
  let nextCharacterId = 1;

  /** 雪花粒子（m00477） */
  let snow = [];
  let snowDeadline = 0;
  /** 当前画布上笔迹的快照，供"横扫 => 飘散"使用 */
  let inkSnapshot = [];

  /** 每只手的跟踪状态（按 MediaPipe 给的 index 区分左右手）。 */
  const handState = new Map();
  const swipeState = new Map();
  /** 最近一帧引擎视角下的手（诊断用：QA 要看掌心/手背到底判成了什么）。 */
  let frameHands = [];

  const listeners = {
    stroke: [],
    erase: [],
    character: [],
    tool: [],
    selection: [],
    settle: [],
    status: [],
  };

  function emit(name, payload) {
    const list = listeners[name];
    if (!list) return;
    for (const fn of list) {
      try {
        fn(payload);
      } catch (error) {
        console.warn('[airwrite] listener failed', name, error);
      }
    }
  }

  /* ---------------- 持久化（刷新后保留工具选择） ---------------- */

  function readSavedStyle() {
    const fallback = { tool: 'pen', color: PALETTE[0], size: PEN_SIZES[0], eraserSize: ERASER_SIZES[0] };
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const raw = localStorage.getItem('airwrite.style');
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return {
        tool: ['pen', 'eraser', 'zoom'].includes(parsed.tool) ? parsed.tool : fallback.tool,
        color: typeof parsed.color === 'string' ? parsed.color : fallback.color,
        size: PEN_SIZES.includes(parsed.size) ? parsed.size : fallback.size,
        eraserSize: ERASER_SIZES.includes(parsed.eraserSize) ? parsed.eraserSize : fallback.eraserSize,
      };
    } catch {
      return fallback;
    }
  }

  function persistStyle() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        'airwrite.style',
        JSON.stringify({
          tool: state.tool,
          color: state.color,
          size: state.size,
          eraserSize: state.eraserSize,
        }),
      );
    } catch {
      /* 隐私模式等场景下静默失败 */
    }
  }

  /* ---------------- 尺寸换算 ---------------- */

  function pixelLength(normalizedUnits) {
    return normalizedUnits * pixelScale;
  }

  /** 画布像素长度 -> 归一化长度，用于橡皮擦半径。 */
  function normalizedLength(px) {
    return px / Math.max(1, pixelScale);
  }

  /**
   * ink 记录器的坐标空间就是引擎的归一化视频坐标，所以 config 里的
   * minSampleDistance / minStrokeLength 已经是最终单位，**不能**再乘 pixelScale。
   * （曾经的写法乘了 pixelScale，导致 minStrokeLength 变成 4 个归一化单位 ——
   * 而整块画面也只有约 1.4 个单位长，于是每一笔都被当成"太短"直接丢弃，
   * 屏幕上永远不会有字。）
   */
  function syncInkSizing() {
    ink.config.minSampleDistance = Math.max(1e-5, cfg.minSampleDistance);
    ink.config.minStrokeLength = Math.max(1e-5, cfg.minStrokeLength);
  }
  syncInkSizing();

  /* ---------------- 笔迹 / 字符 ---------------- */

  function refreshSnapshot(now) {
    const out = [];
    for (const mark of ink.marks) {
      out.push({
        id: mark.id,
        tool: 'pen',
        color: mark.color,
        width: mark.width,
        points: mark.points,
        length: mark.length,
        startedAt: mark.startedAt,
        endedAt: mark.endedAt,
      });
    }
    inkSnapshot = out;
    return out;
  }

  function pendingStrokes() {
    const marks = ink.marks;
    const pendingIds = new Set(ink.pending.map((m) => m.id));
    const out = [];
    for (const mark of marks) {
      if (!pendingIds.has(mark.id)) continue;
      out.push({ id: mark.id, color: mark.color, width: mark.width, points: mark.points });
    }
    return out;
  }

  /** 一个字符写完了：把它的笔迹交给识别器。 */
  function buildCharacter(strokes) {
    const bounds = boundsOf(strokes);
    const character = {
      id: nextCharacterId++,
      seq: charactersSeq++,
      strokes,
      // 笔迹 id 快照：分字撤回时靠它把"这一个字"从 characters 里精确定位出来。
      strokeIds: strokes.map((s) => s.id),
      bounds,
      text: '',
      confidence: 0,
      candidates: [],
      reason: closedReason,
      createdAt: lastCloseAt || nowImpl(),
      ready: false,
    };
    characters.push(character);
    if (characters.length > 60) characters.shift();
    inkVersion += 1;
    emit('character', { character, pending: true });
    if (recognizer) runRecognition(character);
    return character;
  }

  function runRecognition(character) {
    let output;
    try {
      output = recognizer.recognize(character.strokes.map((s) => s.points));
    } catch (error) {
      console.warn('[airwrite] recognizer threw', error);
      output = null;
    }
    const apply = (result) => {
      character.text = (result && result.text) || '?';
      character.confidence = (result && result.confidence) || 0;
      character.candidates = (result && result.candidates) || [];
      character.ready = true;
      emit('character', { character, pending: false });
    };
    if (output && typeof output.then === 'function') {
      output.then(apply).catch(() => apply(null));
    } else if (output) {
      apply(output);
    } else {
      apply(null);
    }
  }

  /**
   * 分字收尾：把 ink 关闭的一个字符接管成引擎字符。
   *
   * 分字是 ink 的职责（它同时看得见停顿多久、提笔后手走开多远、这一笔落在哪），
   * 关闭时机既可能出现在每帧的 tick() 里，也可能出现在 begin() 内部（新一笔落下的
   * 瞬间）。所以这里订阅 ink 的 'character' 事件，而不是用"上一帧 pending 数量"
   * 去猜：猜法会漏掉 begin() 里发生的关闭，那些笔迹就既不在 pending 里、也没被交给
   * 识别器，屏幕上看着像"字写丢了"。
   */
  function adoptInkCharacter(ch) {
    if (!ch || !ch.strokes || !ch.strokes.length) return null;
    const fresh = [];
    for (const mark of ch.strokes) {
      if (mark.id <= assignedThroughId) continue;
      fresh.push({ id: mark.id, color: mark.color, width: mark.width, points: mark.points });
    }
    if (!fresh.length) return null;
    assignedThroughId = fresh[fresh.length - 1].id;
    lastCloseAt = nowImpl();
    closedReason = ch.reason || 'gap';
    return buildCharacter(fresh);
  }

  /**
   * 手动分字（双击捏合 / 面板按钮）。公开 API 和 update() 里的双击检测都走这里，
   * 只有一份实现：先收尾活笔，再把 ink 里待定的笔画封成一个字符。
   *
   * 这里曾经写成调用一个不存在的 `breakCharacter(...)`，浏览器一走到
   * 双击分字这条路径就 ReferenceError 把整个 update 打断（Node 端的
   * test_engine 没覆盖这条路径，所以没暴露）。名字统一成
   * `breakPendingCharacter`，避免和公开方法同名互相遮蔽。
   */
  function breakPendingCharacter(reason) {
    if (ink.live) ink.end(nowImpl());
    // ink.breakCharacter 会同步发出 'character' 事件，由 adoptInkCharacter 接管。
    const closed = ink.breakCharacter(reason);
    if (!closed) return false;
    lastCloseAt = nowImpl();
    refreshSnapshot(nowImpl());
    return true;
  }

  let assignedThroughId = 0;

  /**
   * 撤回一个已经交出去的字（ink 决定"其实还是同一个字"时触发）。
   *
   * 分字为了及时出字，会在 1.1 秒停顿处先把字交出去识别；但用户可能只是在慢慢
   * 写多笔字。ink 发现下一笔就落在旁边、手也没走开时，会把那些笔迹收回 pending
   * 并发出 revoke —— 这里必须把对应的字符从 characters 里摘掉，否则画面上会留下
   * 一个识别错误的"半个字"，同时把 assignedThroughId 回退到前一个字，
   * 保证合并后的字能整段重新识别一次。
   */
  function revokeCharacter(strokes) {
    if (!strokes || !strokes.length) return false;
    const ids = strokes.map((s) => s.id);
    const index = characters.findIndex(
      (c) => c.strokeIds && c.strokeIds.length === ids.length && c.strokeIds[0] === ids[0],
    );
    if (index < 0) return false;
    characters.splice(index, 1);
    assignedThroughId = 0;
    for (const c of characters) {
      const last = c.strokeIds && c.strokeIds.length ? c.strokeIds[c.strokeIds.length - 1] : 0;
      if (last > assignedThroughId) assignedThroughId = last;
    }
    inkVersion += 1;
    refreshSnapshot(nowImpl());
    emit('revoke', { ids });
    return true;
  }

  /* ---------------- 面板 ---------------- */

  function ensurePanel() {
    /* 缓存的签名必须带上 tool：选中橡皮擦后，大小那一行要换成橡皮宽度档
       （26/40），否则面板永远只能改笔宽。改成 'both' 一类的混合布局会把
       橡皮格子当成笔宽写进 state.size，所以这里按当前工具取布局。
       还要带上画布像素尺寸：手机竖屏下几何按像素算行高（见 panel-layout.js
       的 portraitPx 分支），尺寸变了必须重算。 */
    const sig = `${aspect.toFixed(3)}|${state.tool}|${canvasSize.x}x${canvasSize.y}`;
    if (sig !== panelSig) {
      panelSig = sig;
      panel = layoutPanel({
        aspect,
        tool: state.tool,
        width: canvasSize.x,
        height: canvasSize.y,
      });
    }
    return panel;
  }

  function openSelection(now) {
    if (selection.active) return;
    selection.active = true;
    state.selectionMode = true;
    selection.anchor = { ...state.panelAnchor };
    selection.openedAt = now;
    selection.hit = null;
    syncPanelHit(now);
    emit('selection', { active: true });
  }

  function closeSelection() {
    if (!selection.active) return;
    selection.active = false;
    state.selectionMode = false;
    selection.hit = null;
    selection.item = null;
    emit('selection', { active: false });
  }

  /** 视频归一化坐标 -> 画布归一化坐标（面板所在的坐标系）。 */
  function toPanelSpace(point) {
    if (!projector) return { x: point.x, y: point.y };
    const px = projector(point);
    if (!px || !canvasSize.x || !canvasSize.y) return { x: point.x, y: point.y };
    return { x: px.x / canvasSize.x, y: px.y / canvasSize.y };
  }

  function syncPanelHit(now) {
    const layout = ensurePanel();
    let item = null;
    if (selection.active) {
      const panelPoint = toPanelSpace(state.cursor);
      item = hitTest(layout, panelPoint.x, panelPoint.y);
    }
    if (!item) {
      selection.item = null;
      selection.itemSince = now;
      selection.hit = null;
      selection.committed = false;
      return;
    }
    if (!selection.item || selection.item.id !== item.id) {
      selection.item = item;
      selection.itemSince = now;
      /*
       * 换到另一个按钮时必须重新装填。committed 是"这一个按钮已经触发过了"的锁，
       * 不随按钮切换复位的话，一次面板会话里只有第一个悬停的按钮能生效 ——
       * 表现为"选了橡皮擦之后，再怎么悬停颜色和大小都没反应"。
       */
      selection.committed = false;
    }
    const progress = clamp((now - selection.itemSince) / cfg.dwellMs, 0, 1);
    selection.hit = { ...item, progress };
  }

  function previewSelection(label) {
    selection.flash = { label, t: nowImpl() };
  }

  /** 面板上真正被选中的那一下（悬停到 100% 或直接点击）。 */
  function commitSelection(item, now = nowImpl()) {
    if (!item) return;
    applyPanelSelection(item);
    void now;
  }

  /**
   * 面板选择的应用层。panel-ui 的按钮点击和引擎的悬停判定都会走到这里。
   * item = { id, kind, label, value }，value ∈ {tool}|{color}|{size}|{action}
   */
  function applyPanelSelection(item) {
    if (!item || !item.value) return false;
    const value = item.value;
    if (value.tool) {
      setTool(value.tool);
      previewSelection(`已选择：${TOOL_LABELS[value.tool] || value.tool}`);
      /*
       * 面板不自动收起 —— 用户的原话是"选择完相应效果后再次检测到整个手掌则退出选择"
       * （m00304），即"退出"由第二次张开手掌负责，而不是由选择动作负责。
       * 保持打开还有一个实际好处：可以一次会话里连着选 橡皮擦 -> 颜色 -> 大小，
       * 不用为每一档都重新抬一次手。
       *
       * 例外是缩放：它是模态工具，面板留着会挡住画面、而且光标会一直在按钮上悬停，
       * 所以选缩放时收起面板，让捏合留给倍率。
       */
      if (value.tool === 'zoom') closeSelection();
      return true;
    }
    if (value.color) {
      state.color = value.color;
      if (state.tool !== 'pen') state.tool = 'pen';
      persistStyle();
      previewSelection('已选择：颜色');
      emit('tool', toolPayload());
      return true;
    }
    if (value.size !== undefined) {
      if (state.tool === 'eraser') state.eraserSize = value.size;
      else state.size = value.size;
      persistStyle();
      previewSelection(`已选择：大小 ${value.size}`);
      emit('tool', toolPayload());
      return true;
    }
    if (value.action) {
      switch (value.action) {
        case 'undo':
          undo();
          previewSelection('已撤销');
          return true;
        case 'clear':
          clear();
          previewSelection('已清空');
          return true;
        case 'exit':
          closeSelection();
          return true;
        case 'break':
          breakCharacter();
          return true;
        default:
          return false;
      }
    }
    return false;
  }

  function toolPayload() {
    return {
      tool: state.tool,
      color: state.color,
      size: state.tool === 'eraser' ? state.eraserSize : state.size,
      label: state.tool === 'zoom' ? `缩放 ${state.zoom.level.toFixed(2)}×` : TOOL_LABELS[state.tool],
    };
  }

  function setTool(tool) {
    if (!TOOL_LABELS[tool]) return;
    if (state.tool === tool) return;
    state.tool = tool;
    state.toolChangedAt = nowImpl();
    if (tool === 'zoom') {
      state.zoom.active = false;
      state.zoom.panX = 0;
      state.zoom.panY = 0;
    } else {
      state.zoom.active = false;
      state.zoom.panX = 0;
      state.zoom.panY = 0;
    }
    persistStyle();
    emit('tool', toolPayload());
  }

  /* ---------------- 缩放（m00430） ---------------- */

  function updateZoom(hand, now) {
    const zoom = state.zoom;
    const wasActive = zoom.active;
    // tool === 'zoom' 时每帧重新标定"1 倍"：这样从任意画面开始，开合都是以当下为基准。
    zoom.active = state.tool === 'zoom' && !!hand;
    if (!zoom.active) {
      zoom.panX = 0;
      zoom.panY = 0;
      return;
    }
    zoom.span = hand.pinch;
    if (!wasActive) {
      zoom.spanAtEntry = hand.pinch;
      zoom.levelAtEntry = zoom.level;
      zoom.anchorPalm = { x: hand.palmCenter.x, y: hand.palmCenter.y };
      zoom.anchorPan = { x: zoom.panX, y: zoom.panY };
      zoom.level = clamp(zoom.levelAtEntry, cfg.zoomMin, cfg.zoomMax);
      return;
    }
    // 开合比 => 倍率；倍率作用在"进入时的值"上，所以手指再张开一点就再放大一点。
    const ratio = clamp(hand.pinch / Math.max(1e-3, zoom.spanAtEntry), 0.25, 4);
    zoom.level = clamp(zoom.levelAtEntry * ratio, cfg.zoomMin, cfg.zoomMax);
    // pan 是"归一化视频比例"（等于掌心位移），渲染层乘 mapper.pixelScale 换成画布像素。
    zoom.panX = zoom.anchorPan.x + (hand.palmCenter.x - zoom.anchorPalm.x);
    zoom.panY = zoom.anchorPan.y + (hand.palmCenter.y - zoom.anchorPalm.y);
    void now;
  }

  /* ---------------- 雪花飘散（m00477） ---------------- */

  function dissolveInk(now) {
    if (!inkSnapshot.length) return 0;
    const particles = [];
    for (const stroke of inkSnapshot) collectSnow(particles, stroke);
    if (!particles.length) {
      ink.clear();
      inkSnapshot = [];
      return 0;
    }
    if (particles.length > cfg.snowMaxParticles) {
      const stride = particles.length / cfg.snowMaxParticles;
      const kept = [];
      for (let i = 0; i < cfg.snowMaxParticles; i += 1) kept.push(particles[Math.floor(i * stride)]);
      snow = kept;
    } else {
      snow = particles;
    }
    for (const p of snow) {
      // 顺着滑动手势的方向碎开：左边先散、右边后散（x 越大越晚）
      p.delay = Math.max(0, p.x - 0.12) * 620 + Math.random() * 180;
      p.bornAt = now;
    }
    snowDeadline =
      now + cfg.snowCrackMs + cfg.snowRiseMs * 1.4 + cfg.snowHoldMs + cfg.snowFadeMs + 900;
    ink.clear();
    inkSnapshot = [];
    inkVersion += 1;
    emit('status', { text: '手背横扫：字迹像雪花一样飘散' });
    return snow.length;
  }

  function collectSnow(out, stroke) {
    const points = stroke.points || [];
    if (points.length < 2) return;
    // 按弧长采样，密度由 snowStepPx（CSS 像素）决定：点越多雪花越密。
    const step = Math.max(1e-4, normalizedLength(cfg.snowStepPx));
    let carry = step; // 从第一段就开始取样，短笔画也能飘起来
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      carry += Math.hypot(b.x - a.x, b.y - a.y);
      if (carry < step && i < points.length - 1) continue;
      carry = 0;
      out.push(makeSnow(stroke, a, b));
    }
  }

  function makeSnow(stroke, a, b) {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    // depth 0 = 远处的小碎屑，1 = 近处的大片雪花：尺寸/速度/亮度都跟着分层，
    // 这样散开时才有前后景，而不是一片同样大的点。
    const depth = Math.random();
    const near = 0.45 + depth * 0.85;
    return {
      id: particleSeq++,
      x,
      y,
      vx: (Math.random() - 0.5) * 0.02 + 0.005,
      vy: 0.035 + Math.random() * 0.05,
      ax: (Math.random() - 0.5) * 0.12,
      ay: 0.002 + Math.random() * 0.0025,
      swayAmp: 0.004 + Math.random() * 0.014,
      swayFreq: 0.6 + Math.random() * 1.8,
      rot: angle,
      rotV: (Math.random() - 0.5) * 1.6,
      size: Math.max(1.1, stroke.width * (0.5 + Math.random() * 0.75) * near),
      color: stroke.color,
      depth,
      variant: particleSeq % 4,
      seed: Math.random() * TAU,
      twinkle: Math.random() < cfg.snowTwinkleFraction ? 0.6 + Math.random() * 1.6 : 0,
      bornAt: 0,
      delay: 0,
      lifeAt: 0,
      lastAge: 0,
    };
  }

  function updateSnow(now) {
    if (!snow.length) return;
    const hold = cfg.snowHoldMs;
    const fade = cfg.snowFadeMs;
    const rise = cfg.snowRiseMs;
    const crack = cfg.snowCrackMs;
    const kept = [];
    for (const p of snow) {
      const age = now - p.bornAt - p.delay;
      if (age < 0) {
        kept.push(p);
        continue;
      }
      // 用真实帧间隔推进。以前拿"累计年龄"当步长，等于把速度绑在年龄上，
      // 帧率一变观感就变，飘散快慢也没法调。
      const dt = Math.min(0.05, Math.max(0, (age - (p.lastAge || 0)) / 1000));
      p.lastAge = age;
      p.lifeAt = age;

      // 结晶：先在原地定住（只留一点微光抖动），让"字碎成雪"的形状看清一瞬
      const crystal = clamp(age / Math.max(1, crack), 0, 1);
      // 散开：抬起是一记钟形脉冲（期末归零），此后纯自由落体
      const drift = clamp((age - crack) / Math.max(1, rise), 0, 1);
      const pop = drift > 0 && drift < 1 ? Math.sin(Math.PI * drift) : 0;
      const held = crystal < 1 ? 1 - crystal : 0;
      const swayPhase = p.swayFreq * age * 0.001 * TAU + p.seed;
      p.x +=
        (p.vx * drift +
          Math.cos(swayPhase) * p.swayAmp * (3.2 * drift + 0.5 * held) +
          cfg.snowGustX * drift * (1 - p.depth * 0.55)) *
        dt;
      p.y += (p.vy * drift * drift - 0.16 * pop) * dt;
      p.vx += p.ax * (0.6 + Math.sin(swayPhase) * 0.7) * drift * dt;
      p.vy += p.ay * dt;
      p.rot += p.rotV * 0.3 * (0.35 + drift) * dt;
      if (age > crack + rise * 1.4 + hold + fade) continue;
      kept.push(p);
    }
    snow = kept;
    if (!snow.length || now > snowDeadline) {
      if (snow.length && now > snowDeadline) snow = [];
      emit('settle', { kind: 'snow', particles: 0 });
      snowDeadline = 0;
    }
  }

  function snowAlpha(p) {
    if (p.lifeAt <= 0) return 0;
    // 结晶前段快速淡入：字迹是被"结晶"替换掉的，不能一开始就半透明
    const appear = clamp(p.lifeAt / Math.max(1, cfg.snowCrackMs * 0.6), 0, 1);
    const fade = clamp((p.lifeAt - cfg.snowHoldMs) / cfg.snowFadeMs, 0, 1);
    let a = appear * (1 - fade);
    // 结晶期不闪：先把"字碎成雪"的形状看清；散开之后才偶尔眨一下
    if (p.twinkle && p.lifeAt > cfg.snowCrackMs) {
      a *= 0.78 + 0.22 * Math.sin(p.lifeAt * 0.006 * p.twinkle + p.seed);
    }
    return clamp(a, 0, 1);
  }

  /* ---------------- 手掌横扫（m00477） ---------------- */

  function updateSwipe(hand, now) {
    const id = hand.key;
    let hist = swipeState.get(id);
    if (!hist) {
      hist = { track: [], armed: true, fired: false };
      swipeState.set(id, hist);
    }
    hist.track.push({ x: hand.metrics.wrist.x, y: hand.metrics.wrist.y, t: now });
    while (hist.track.length && now - hist.track[0].t > 900) hist.track.shift();

    if (!hist.armed) {
      // 手掌退回去（或离开画面）后重新武装，避免一次横扫连续触发。
      if (hand.metrics.wrist.x < hist.lastFiredX - 0.28) hist.armed = true;
      return false;
    }
    if (hist.track.length < 4) return false;

    const start = hist.track[0];
    let minX = start.x;
    let minY = start.y;
    let maxX = start.x;
    let maxY = start.y;
    for (const s of hist.track) {
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
    }
    const travel = maxX - minX;
    const drift = maxY - minY;
    const duration = now - start.t;
    if (duration > 900) return false;
    if (travel < cfg.snowMinTravel || drift > cfg.snowMaxDrift) return false;
    if (maxX - start.x < cfg.snowMinTravel * 0.6) return false; // 必须整体朝右

    hist.armed = false;
    hist.fired = true;
    hist.lastFiredX = maxX;
    return true;
  }

  /* ---------------- 每帧主循环 ---------------- */

  /**
   * 每帧主循环。
   *
   * @param {Array|object|null} hands hands pipeline output（原始 keypoint 或手对象）
   * @param {number} [nowIn] 时间戳，省略则用内部时钟
   * @param {{mirror?:boolean}} [options] mirror：坐标是否已按镜像预览翻转
   *   （app.js 传 state.mirrored）。掌心/手背的判定需要它，默认 true。
   */
  function update(hands, nowIn, options = {}) {
    const mirrored = options.mirror !== false;
    const now = Number.isFinite(nowIn) ? nowIn : nowImpl();
    ensurePanel();
    // ink.js 负责"什么时候算写完一个字"（停顿 / 走开 / 手动分字），关闭时它同步
    // 发出 'character' 事件，由 adoptInkCharacter 接管成引擎字符，这里只管推它一帧。
    ink.tick(now);
    updateSnow(now);
    if (!snow.length && snowDeadline && now > snowDeadline) snowDeadline = 0;

    const list = Array.isArray(hands) ? hands : hands ? [hands] : [];
    const live = new Set();
    const metricsList = [];

    for (const hand of list) {
      const raw = hand.screen || hand.landmarks || hand.world;
      const key = hand.key !== undefined ? String(hand.key) : String(hand.index ?? 0);
      live.add(key);
      const metrics = handMetrics(raw, { mirrored, handedness: hand.label });
      if (!metrics) continue;
      metricsList.push({ key, hand, metrics });
      let hs = handState.get(key);
      const firstSight = !hs;
      if (!hs) {
        hs = {
          id: key,
          smoothedPinch: metrics.pinch,
          drawArmed: true,
          palmStreak: 0,
          palmMs: 0,
          palmSeenAt: 0,
          dissolveSince: 0,
          lastSeenAt: now,
          lastRawPinch: metrics.pinch,
          /** 提笔迟滞：捏合值开始持续超过 pinchEnd 的时刻（0 = 没在提笔）。 */
          penUpSince: 0,
        };
        handState.set(key, hs);
      }
      // 这一帧距上次真正看见这只手多久（丢帧时帧间隔会突然变大，不能当成手势时长）
      const frameDt = firstSight ? 0 : Math.max(0, Math.min(200, now - hs.lastSeenAt));
      hs.lastSeenAt = now;
      hs.lastRawPinch = metrics.pinch;
      hs.smoothedPinch = smooth(hs.smoothedPinch, metrics.pinch, cfg.pinchSmooth);
      /*
       * 张开手掌计时：**累计**满足 palm 的时长，只在小间隙内保持。
       *
       * 旧实现要求严格连续（任何一帧 palm 为假就清零）：真的张开手掌时中间抖掉
       * 一帧就永远开不了面板，反过来写字时闪过几帧 palm（握笔的余势）又能误弹。
       * 现在按帧真实间隔累加，间隙超过 palmGapMs 才清零，并且"正在写 / 刚提笔"
       * 的 drawCooldownMs 内根本不计时 —— 那是在写字，不是在比手势。
       */
      const recentlyDrew =
        state.drawing || (ink.lastStrokeEnd > 0 && now - ink.lastStrokeEnd < cfg.drawCooldownMs);
      if (metrics.palm && !recentlyDrew) {
        if (hs.palmMs === 0) hs.palmSince = now;
        hs.palmMs += frameDt;
        hs.palmSeenAt = now;
      } else if (hs.palmMs > 0 && now - hs.palmSeenAt > cfg.palmGapMs) {
        hs.palmMs = 0;
        hs.palmSince = 0;
      }
    }

    /*
     * 手丢失：宽限期内保留状态，超时才真删。
     * 一两帧检测闪断不该把在写的笔画切断（那是"手还在写"），
     * 但手真的离开画面后必须收笔，不能一直握着一支看不见的笔。
     */
    for (const key of [...handState.keys()]) {
      if (live.has(key)) continue;
      const hs = handState.get(key);
      if (now - hs.lastSeenAt < cfg.handGraceMs) continue;
      handState.delete(key);
    }
    for (const key of [...swipeState.keys()]) {
      if (!live.has(key)) swipeState.delete(key);
    }

    frameHands = metricsList.map(({ key, metrics }) => ({
      key,
      kind: metrics.kind,
      facing: metrics.palmFacing,
      palm: !!metrics.palm,
      flat: !!metrics.flat,
      dissolve: isDissolvePose(metrics),
      pinch: Number(metrics.pinch.toFixed(3)),
    }));

    // 1) 手背向右横扫 => 雪花飘散（m00477 起，m02869 改为手背触发）。
    //    必须排在"张开手掌开面板"之前：两者的姿态高度重叠，如果先开面板，
    //    selection.active 会让横扫分支永远进不去，用户就再也扫不散字了。
    //    姿态门槛见 isDissolvePose：手背朝镜头，或"伸直但没摊平"的平手。
    //    横扫成功后把这只手锁存（palmLatched），这一掌不再当作"开/关面板"。
    let swept = false;
    if (inkSnapshot.length) {
      for (const entry of metricsList) {
        const hs = handState.get(entry.key);
        const pose = isDissolvePose(entry.metrics);
        /*
         * 姿态要连续保持 dissolveHoldMs：横扫途中偶然闪过一两帧"手背/平手"
         * 不该把字散掉 —— 那通常是追踪抖动，而不是用户真的把手翻过来挥。
         *
         * 但要求不能死板：一次很快的真横扫本身可能还不到 dissolveHoldMs，
         * 所以门槛取 min(姿态保持时长, 这一趟横扫已积累的时长) —— 姿态从起手
         * 就一直成立时，横扫多快都算数；只有"手势里夹了几帧手背"才会被挡。
         */
        if (hs) {
          if (pose) {
            if (!hs.dissolveSince) hs.dissolveSince = now;
          } else {
            hs.dissolveSince = 0;
          }
        }
        if (!pose) continue;
        const hist = swipeState.get(entry.key);
        const trackSpan = hist && hist.track.length ? now - hist.track[0].t : 0;
        const needHold = Math.min(cfg.dissolveHoldMs, Math.max(0, trackSpan));
        if (hs && now - hs.dissolveSince < needHold) continue;
        if (!updateSwipe(entry, now)) continue;
        dissolveInk(now);
        if (hs) hs.palmLatched = true;
        closeSelection();
        swept = true;
        break;
      }
    }

    // 2) 面板开关：任何一只"张开手掌"的手都能触发（m00209 / m00304）
    for (const entry of metricsList) {
      if (swept) break;
      const hs = handState.get(entry.key);
      if (!hs || !entry.metrics.palm) continue;
      // palmMs 是累计时长（允许 palmGapMs 内的抖动间隙），不是连续帧计数
      if (!hs.palmLatched && hs.palmMs >= cfg.palmHoldMs) {
        hs.palmLatched = true;
        // 用掉的时长清零：一次手势只开关一次，想再来一次得重新按住
        hs.palmMs = 0;
        hs.palmSince = 0;
        if (selection.active) closeSelection();
        else openSelection(now);
      }
    }
    for (const entry of metricsList) {
      const hs = handState.get(entry.key);
      // 锁存要等这只手离开 palm 姿态一会儿才解除：中间抖掉一帧不该让同一次
      // "张开手掌"再触发一次（那会把刚打开的面板又立刻关掉）。窗口取 80ms：
      // 小到"收回手 200ms 再张开"仍然算第二次，大到能吃掉单帧抖动。
      if (
        hs &&
        !entry.metrics.palm &&
        now - hs.palmSeenAt > cfg.palmLatchReleaseMs
      ) {
        hs.palmLatched = false;
      }
    }

    // 3) 主手：优先捏得最紧的那只
    let primary = null;
    for (const entry of metricsList) {
      if (!primary || entry.metrics.pinch < primary.metrics.pinch) primary = entry;
    }

    // 4) 选择模式下的光标 + 悬停
    const primaryState = primary ? handState.get(primary.key) : null;
    const primaryPinch = primaryState ? primaryState.smoothedPinch : 1;
    if (selection.active && primary) {
      state.cursor.x = primary.metrics.indexTip.x;
      state.cursor.y = primary.metrics.indexTip.y;
      state.cursor.active = true;
      state.cursor.pinch = primaryPinch;
      state.panelAnchor = { ...primary.metrics.palmCenter };
      syncPanelHit(now);
      if (selection.hit && selection.hit.progress >= 1 && !selection.committed) {
        // 悬停满 dwellMs：选中一次，然后锁存到光标离开这个按钮为止。
        selection.committed = true;
        commitSelection(selection.hit, now);
      }
    } else if (!selection.active) {
      state.cursor.active = false;
      if (primary) {
        state.cursor.x = primary.metrics.indexTip.x;
        state.cursor.y = primary.metrics.indexTip.y;
        state.cursor.pinch = primaryPinch;
      }
      selection.hit = null;
      // 关面板时必须连 item 一起清掉：否则下次开面板时光标恰好落在同一个按钮上，
      // syncPanelHit 会因为 id 相同而沿用旧的 itemSince，把上一轮的悬停时间算进来。
      selection.item = null;
      selection.committed = false;
    } else {
      // 面板开着但暂时没检测到手：光标熄灭，进度清零，避免"定格"误触。
      state.cursor.active = false;
      selection.hit = null;
      selection.item = null;
      selection.committed = false;
    }

    // 4) 缩放（m00430）
    updateZoom(primary ? primary.metrics : null, now);

    // 5) 书写：捏合落笔 / 松开提笔
    const pen = state.tool === 'pen' ? primary : null;
    if (pen) {
      const hs = handState.get(pen.key);
      const pinch = hs.smoothedPinch;
      const mid = pen.metrics.pinchMid;
      /*
       * 握拳不能落笔：拳头的拇指尖本来就压在食指尖上（合成手实测 pinch=0.133），
       * 只看捏合距离的话"攥一下拳"会被当成捏笔，直接在画布上留一道。
       * 四指全蜷（或分类器判成 fist）时一律不开始新笔画。
       */
      const gripped = pen.metrics.kind === 'fist' || pen.metrics.curled;
      if (state.drawing) {
        /*
         * 提笔迟滞：捏合值要"稳定"超过 pinchEnd 这么久才算真提笔。
         * 单帧的 landmark 抖动会把 smoothedPinch 顶过 0.6 一下，原来立刻 endStroke，
         * 一笔就被切成两笔、字也跟着碎；真松开手时捏合值会一直高，90ms 内就收笔。
         */
        if (pinch >= cfg.pinchEnd) {
          if (!hs.penUpSince) hs.penUpSince = now;
          else if (now - hs.penUpSince >= cfg.penUpHoldMs) endStroke(now);
        } else {
          hs.penUpSince = 0;
          moveStroke(mid, now);
        }
      } else if (pinch <= cfg.pinchStart && !selection.active && !gripped) {
        // 双击分字：两次落笔间隔很短 => 手动换字
        if (now - lastPenDownAt < cfg.doublePinchMs && ink.pending.length) {
          breakPendingCharacter('manual');
        }
        hs.penUpSince = 0;
        startStroke(pen.metrics, now);
      } else if (pinch <= cfg.pinchStart) {
        state.cursor.pinch = pinch;
      }
      /*
       * 提笔期间每帧喂一次位置：分字要靠"手走开多远"来判断是不是换了字。
       * 只在没写的时候累积，写的时候位移属于笔画本身。
       */
      if (!state.drawing) ink.hover(mid.x, mid.y);
    } else if (state.drawing) {
      /*
       * 这一帧没看见任何手：刚还在写就先别收笔 —— 检测闪断（丢一两帧）会把一笔
       * 切成两笔，字也跟着碎。只有宽限期外（手真的离开画面）才收笔。
       */
      const gracing = [...handState.values()].some(
        (s) => now - s.lastSeenAt < cfg.handGraceMs,
      );
      if (!gracing) endStroke(now);
    }

    // 6) 橡皮擦
    const eraser = state.tool === 'eraser' ? primary : null;
    if (eraser) {
      const hs = handState.get(eraser.key);
      if (hs.smoothedPinch <= cfg.pinchStart) {
        eraseAt(eraser.metrics, now);
      }
    }

    // 7) 手掌向右横扫已在第 1 步处理（必须先于面板开关）。

    if (state.drawing && state.tool !== 'pen') endStroke(now);

    return snapshotState();
  }

  /* ---------------- 笔迹操作 ---------------- */

  function startStroke(metrics, now) {
    if (state.tool !== 'pen') return null;
    if (selection.active) return null;
    lastPenDownAt = now;
    state.drawing = true;
    const started = ink.begin(metrics.pinchMid.x, metrics.pinchMid.y, now, {
      tool: 'pen',
      color: state.color,
      width: state.size,
    });
    return started;
  }

  function moveStroke(point, now) {
    if (!state.drawing) return;
    ink.move(point.x, point.y, now);
  }

  function endStroke(now) {
    if (!state.drawing && !ink.live) return;
    state.drawing = false;
    const result = ink.end(now);
    if (result && result.id) {
      inkVersion += 1;
      refreshSnapshot(now);
      emit('stroke', { stroke: inkSnapshot[inkSnapshot.length - 1] });
    } else {
      inkVersion += 1;
      refreshSnapshot(now);
    }
  }

  /** 橡皮擦打薄时真正删掉的笔迹 id（同时从 ink.marks 里摘掉，避免它继续参与分字）。 */
  function eraseAt(metrics, now) {
    const radius = normalizedLength(state.eraserSize);
    const eraserPoint = metrics.pinchMid;
    const doomed = [];
    for (const mark of ink.marks) {
      if (maskHasHit(mark, eraserPoint, radius)) doomed.push(mark.id);
    }
    if (!doomed.length) return 0;
    const doomedSet = new Set(doomed);
    /* 走记录器的公开方法：ink.marks 只有 getter，直接赋值会在严格模式模块里抛
       TypeError 并把整个 update 打断（浏览器自检 F 段抓到的崩溃）。 */
    ink.removeMarks(doomedSet);
    // 如果待分字的笔迹被擦掉了，已分配到的 id 也要回退，否则下一次分字会漏掉新笔迹。
    if (assignedThroughId >= Math.min(...doomed)) {
      let back = 0;
      for (const mark of ink.marks) if (mark.id <= assignedThroughId + 1) back = Math.max(back, mark.id);
      assignedThroughId = back;
    }
    refreshSnapshot(now);
    inkVersion += 1;
    emit('erase', { removed: doomed.length });
    return doomed.length;
  }
  function maskHasHit(mark, point, radius) {
    const r2 = radius * radius;
    const points = mark.points;
    // points 是 {x,y} 对象数组，步长必须是 1（曾经写成 2，等于漏掉一半采样点）。
    for (let i = 0; i < points.length; i += 1) {
      const dx = points[i].x - point.x;
      const dy = points[i].y - point.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  /* ---------------- 指针兜底（无摄像头） ---------------- */

  let pointerActive = false;

  /* ---------------- 对外接口 ---------------- */

  const api = {
    config: cfg,
    state,
    selection,
    get strokes() {
      return inkSnapshot;
    },
    get liveStroke() {
      const live = ink.live;
      if (!live) return null;
      return {
        id: live.id,
        tool: 'pen',
        color: live.color,
        width: live.width,
        points: live.points,
      };
    },
    get characters() {
      return characters;
    },
    get cursor() {
      return state.cursor;
    },
    get zoom() {
      return state.zoom;
    },
    get toolLayout() {
      // 取的时候顺手确保布局跟当前工具一致：否则刚 setTool 完就读的话会拿到旧尺寸行
      return ensurePanel();
    },
    get strokesVersion() {
      return inkVersion;
    },
    get maskVersion() {
      return inkVersion;
    },
    get snowParticles() {
      return snow;
    },
    get isSnowing() {
      return snow.length > 0;
    },
    /** 最近一帧的手势诊断（key/kind/facing/palm/flat/dissolve/pinch）。 */
    get hands() {
      return frameHands;
    },
    snowAlpha,

    /** 引擎每帧调用一次；`hands` 允许是 rig 的 results.hands。 */
    update,

    /** 画布尺寸变化时调用，用于把"CSS 像素尺寸"换算成归一化尺寸。 */
    setViewport({ pixelScale: scale, aspect: ratio, project, canvasWidth, canvasHeight } = {}) {
      if (Number.isFinite(scale) && scale > 0) pixelScale = scale;
      if (Number.isFinite(ratio) && ratio > 0) aspect = ratio;
      if (typeof project === 'function') projector = project;
      if (Number.isFinite(canvasWidth) && canvasWidth > 0) canvasSize.x = canvasWidth;
      if (Number.isFinite(canvasHeight) && canvasHeight > 0) canvasSize.y = canvasHeight;
      syncInkSizing();
      ensurePanel();
    },

    /* --- 面板 --- */
    openSelection: () => openSelection(nowImpl()),
    closeSelection,
    toggleSelection() {
      if (selection.active) closeSelection();
      else openSelection(nowImpl());
    },
    applyPanelSelection,

    /* --- 工具 --- */
    setTool,
    setColor(color) {
      applyPanelSelection({ id: 'api-color', kind: 'color', label: '颜色', value: { color } });
    },
    setSize(size) {
      applyPanelSelection({ id: 'api-size', kind: 'size', label: '大小', value: { size } });
    },
    setZoom(level, pan = {}) {
      state.zoom.level = clamp(level, cfg.zoomMin, cfg.zoomMax);
      if (Number.isFinite(pan.panX)) state.zoom.panX = pan.panX;
      if (Number.isFinite(pan.panY)) state.zoom.panY = pan.panY;
    },
    resetZoom() {
      state.zoom.level = 1;
      state.zoom.panX = 0;
      state.zoom.panY = 0;
      state.zoom.spanAtEntry = state.zoom.span;
      state.zoom.levelAtEntry = 1;
    },

    /* --- 笔迹 --- */
    undo() {
      if (ink.live) {
        ink.undo();
        state.drawing = false;
      } else {
        ink.undo();
      }
      refreshSnapshot(nowImpl());
      inkVersion += 1;
      return true;
    },
    clear() {
      ink.clear();
      snow = [];
      snowDeadline = 0;
      inkSnapshot = [];
      inkVersion += 1;
      emit('status', { text: '已清空' });
      return true;
    },
    breakCharacter(reason = 'manual') {
      return breakPendingCharacter(reason);
    },
    dissolve() {
      return dissolveInk(nowImpl());
    },

    /* --- 指针兜底 --- */
    pointerDown(point, now = nowImpl()) {
      pointerActive = true;
      if (state.tool !== 'pen' || selection.active) return false;
      lastPenDownAt = now;
      state.drawing = true;
      const metrics = {
        pinchMid: { x: point.x, y: point.y },
        indexTip: { x: point.x, y: point.y },
        palmCenter: { x: point.x, y: point.y },
      };
      ink.begin(metrics.pinchMid.x, metrics.pinchMid.y, now, {
        tool: 'pen',
        color: state.color,
        width: state.size,
      });
      return true;
    },
    pointerMove(point, now = nowImpl()) {
      if (!pointerActive || !state.drawing) return false;
      ink.move(point.x, point.y, now);
      return true;
    },
    pointerUp(now = nowImpl()) {
      pointerActive = false;
      if (!state.drawing) return false;
      endStroke(now);
      return true;
    },

    /* --- 事件 --- */
    on(name, fn) {
      const list = listeners[name];
      if (!list) return () => {};
      list.push(fn);
      return () => {
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },

    stats() {
      const inkStats = ink.stats();
      return {
        strokes: inkSnapshot.length,
        points: inkSnapshot.reduce((sum, s) => sum + s.points.length, 0),
        pendingStrokes: ink.pending.length,
        characters: characters.length,
        /* 分字诊断（m02798）：被当成追踪跳变丢掉的采样、被撤回合并的字符数、
           提笔后手平移了多远（0~1 归一化）。 */
        dropped: inkStats.dropped,
        revoked: inkStats.revoked,
        travel: inkStats.travel,
        snow: snow.length,
        tool: state.tool,
        zoom: state.zoom.level,
        selection: selection.active,
      };
    },

    /** 便于自检模块直接复用。 */
    _internals: { ink, handMetrics, pixelLength, normalizedLength, toPanelSpace, get view() { return { pixelScale, aspect, hasProjector: !!projector, canvas: { ...canvasSize } }; } },
  };

  function snapshotState() {
    return state;
  }

  function boundsOf(strokes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  return api;
}
