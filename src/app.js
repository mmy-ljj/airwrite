/**
 * 隔空写字 AirWrite — 应用外壳。
 *
 * 职责，按顺序：
 *   1. DOM 接线（按钮 / 状态 / 统计 / 开始卡片 / 错误卡片 / 全屏）
 *   2. 组装三件套：Rig（摄像头或合成帧）→ 引擎（手势→笔迹）→ 渲染器（画布）
 *   3. 每帧一次 update + draw
 *   4. 指针兜底：没有摄像头时也能用鼠标写字、点面板格子
 *
 * 逻辑全在 src/airwrite/*（引擎、识别、面板、渲染）与 src/vision/*（手势）里，
 * 这里只做接线，方便单独测试那两层的纯逻辑。
 */

import { Rig } from './rig.js';
import { ViewMapper } from './render/mapper.js';
import { createHandsTracker } from './vision/hands.js';
import { SmoothedValue } from './vision/smoothing.js';
import { createAirWriteEngine, TOOL_LABELS } from './airwrite/engine.js';
import { createRecognizer } from './airwrite/recognizer.js';
import { createAirWriteRenderer } from './airwrite/render.js';
import { createGlyphDemoFrames } from './airwrite/demo-glyph.js';

const $ = (id) => document.getElementById(id);

const dom = {
  stage: $('stage'),
  video: $('camera'),
  ink: $('ink'),
  overlay: $('overlay'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  start: $('btn-start'),
  undo: $('btn-undo'),
  clear: $('btn-clear'),
  mirror: $('btn-mirror'),
  full: $('btn-full'),
  help: $('btn-help'),
  chipTool: $('chip-tool'),
  chipColor: $('chip-color'),
  chipColorName: $('chip-color-name'),
  chipSize: $('chip-size'),
  chipStats: $('chip-stats'),
  chipFps: $('chip-fps'),
  startCard: $('start-card'),
  begin: $('btn-begin'),
  demo: $('btn-demo'),
  helpCard: $('help-card'),
  helpClose: $('btn-help-close'),
  errorCard: $('error'),
  errorTitle: $('error-title'),
  errorText: $('error-text'),
  errorDetail: $('error-detail'),
  errorRetry: $('btn-error-retry'),
  errorDemo: $('btn-error-demo'),
  errorClose: $('btn-error-close'),
};

const params = new URLSearchParams(location.search);

const state = {
  source: params.get('source') === 'demo' ? 'demo' : 'camera',
  running: false,
  started: false,
  mirrored: true,
  busy: false,
  fpsSmooth: new SmoothedValue(0.35, 0),
  lastCard: 'start',
};

/* ------------------------------------------------------------- 三件套 --- */

const engine = createAirWriteEngine({ recognizer: createRecognizer() });
const mapper = new ViewMapper();
const renderer = createAirWriteRenderer({
  canvas: dom.overlay,
  inkCanvas: dom.ink,
  mapper,
  engine,
});

let rig = null;
let viewport = { width: 0, height: 0 };

/**
 * 移动端判定：粗指针（触屏）或手机 UA。用来做几件确定性的取舍 ——
 * 只追踪一只手、推理限到 30fps、跳过 iOS 不支持的全屏、申请屏幕常亮。
 */
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const IS_MOBILE =
  IS_TOUCH || /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MicroMessenger/i.test(navigator.userAgent || '');
const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
  (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);

const demoFrames = createGlyphDemoFrames({ keys: ['A', '5', 'H', 'I'] });

/* -------------------------------------------------------------- 视口 --- */

function resize() {
  const width = dom.stage.clientWidth || window.innerWidth;
  const height = dom.stage.clientHeight || window.innerHeight;
  if (width === viewport.width && height === viewport.height) return false;
  viewport = { width, height };
  renderer.resize({ width, height });
  return true;
}

/* ------------------------------------------------------------- 每帧 --- */

let hudTick = 0;
let lastHands = [];

/** 自拍镜像：把 x 翻到 1-x。在数据层做，而不是 CSS 翻画布——
    这样画布上的中文不会变成镜像字，而手/笔迹/光标/面板命中仍然全部一致。 */
function mirrorPointList(points) {
  if (!Array.isArray(points)) return points;
  return points.map((p) => (p && typeof p.x === 'number' ? { ...p, x: 1 - p.x } : p));
}

function mirrorPoint(point) {
  return point && typeof point.x === 'number' ? { ...point, x: 1 - point.x } : point;
}

const MIRRORED_POINTS = ['wrist', 'palmCenter', 'indexTip', 'thumbTip', 'middleTip', 'ringTip', 'pinkyTip', 'indexMcp'];

function mirrorHands(hands) {
  return hands.map((hand) => {
    const out = { ...hand, screen: mirrorPointList(hand.screen) };
    for (const key of MIRRORED_POINTS) if (out[key]) out[key] = mirrorPoint(out[key]);
    return out;
  });
}

function onFrame(results) {
  const now = results.ts ?? performance.now();
  const raw = results.hands || [];
  const hands = state.mirrored ? mirrorHands(raw) : raw;
  lastHands = hands;
  resize();
  engine.update(hands, now, { mirror: state.mirrored });
  renderer.draw({ video: rig && !rig.isDemo ? rig.video : null, now });
  updateHud(now, hands);
  renderedFrames += 1;
  qaTick();
}

function updateHud(now, hands) {
  state.fpsSmooth.push(rig ? rig.fps : 0, now);
  hudTick += 1;
  if (hudTick % 10 !== 0) return; // 文本节点不便宜，约 6Hz 刷新就够
  syncChips();
  dom.chipFps.textContent = `${Math.round(state.fpsSmooth.value)} FPS`;
  const strokes = engine.strokes.length;
  const chars = engine.characters.length;
  const text = engine.characters.map((c) => (c.ready ? c.text || '?' : '…')).join('');
  dom.chipStats.textContent = `笔迹 ${strokes} · 字 ${chars}${text ? ` · ${text}` : ''}`;
  void hands;
}

function syncChips() {
  const tool = engine.state.tool;
  dom.chipTool.textContent = TOOL_LABELS[tool] || tool;
  dom.chipColorName.textContent = engine.state.color;
  dom.chipColor.style.background = engine.state.color;
  dom.chipSize.textContent = String(tool === 'eraser' ? engine.state.eraserSize : engine.state.size);
}

function setStatus(text, kind = 'busy') {
  dom.statusText.textContent = text;
  dom.statusDot.dataset.kind = kind;
}

const DEFAULT_HINT = '张开手掌 → 选工具 · 食指悬停选择 · 再次张开手掌退出';
let hintTimer = 0;

/** 引擎的状态事件借底部提示条显示一小会儿（例如“已清空”“字迹像雪花一样飘散”）。 */
function flashHint(text, ms = 2200) {
  dom.hint.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    dom.hint.textContent = DEFAULT_HINT;
  }, ms);
}

function showCard(which) {
  state.lastCard = which;
  for (const [name, el] of [
    ['start', dom.startCard],
    ['help', dom.helpCard],
    ['error', dom.errorCard],
  ]) {
    if (el) el.hidden = name !== which;
  }
}

function hideCards() {
  showCard(null);
}

/* ---------------------------------------------------------- 启动 / 停止 --- */

async function ensureRig() {
  if (rig) return rig;
  rig = new Rig({
    video: dom.video,
    // 手机上 60fps 的 MediaPipe 推理只会发热降频；30fps 追踪 + 每帧渲染最稳。
    maxInferFps: IS_MOBILE ? 30 : 0,
  });
  rig.setDemoGenerator(demoFrames);
  rig.register(
    createHandsTracker({
      // 一只手就够写字；手机上少追一只 = 少一半推理开销。
      numHands: IS_MOBILE ? 1 : 2,
      onError: (err) => handleError(err),
    }),
  );
  rig.onFrame(onFrame);
  return rig;
}

/** 屏幕常亮：写字时手不碰屏幕，手机很容易自动锁屏。失败就算了（桌面/IOS 旧版）。 */
let wakeLock = null;
async function acquireWakeLock() {
  if (!IS_MOBILE || !navigator.wakeLock?.request) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  try {
    wakeLock?.release?.();
  } catch {
    /* 已经释放过 */
  }
  wakeLock = null;
}

/** iOS 偶尔拒绝非手势的 play()：让用户在画面上点一下，补上那次播放。 */
function tapToResume(r) {
  setStatus('点一下画面继续（手机浏览器需要一次点击才允许播放）', 'busy');
  return new Promise((resolve, reject) => {
    const once = async () => {
      clearTimeout(timer);
      dom.stage.removeEventListener('pointerdown', once);
      setStatus('正在恢复摄像头…');
      await r.resume();
      resolve();
    };
    const timer = setTimeout(() => {
      dom.stage.removeEventListener('pointerdown', once);
      reject(new Error('camera produced no frames (is another app using it?)'));
    }, 12000);
    dom.stage.addEventListener('pointerdown', once);
  });
}

async function start(source = state.source) {
  if (state.busy) return;
  state.busy = true;
  state.source = source;
  dom.start.disabled = true;
  try {
    const r = await ensureRig();
    if (source === 'demo') {
      await r.setSource('demo');
      setMirrored(false);
      state.running = true;
      state.started = true;
      setStatus('演示模式 · 合成手正在写字', 'ok');
      hideCards();
      resize();
      r.start();
      maybeOpenPanel();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        IS_MOBILE
          ? '这个手机浏览器不支持摄像头 API。请用较新的 Safari / Chrome，并通过 https:// 地址打开。'
          : '这个浏览器不支持摄像头 API。请用较新的 Chrome / Edge，并通过 http://localhost 打开。',
      );
    }
    await r.setSource('camera');
    setMirrored(true);
    setStatus(IS_IOS ? '请在弹窗里点「允许」使用摄像头…' : '请在弹窗里允许使用摄像头…');
    let size = await r.openCamera();
    if (size.needsGesture) {
      await tapToResume(r);
      size = await r.waitForFrames(8000);
    }
    setStatus('正在加载 MediaPipe 手部模型…');
    await r.load(({ phase, id }) => {
      if (phase === 'init') setStatus(`正在加载模型：${id}`);
    });
    state.running = true;
    state.started = true;
    setStatus(`运行中 · ${size.width}×${size.height}`, 'ok');
    hideCards();
    resize();
    r.start();
    acquireWakeLock();
    maybeOpenPanel();
  } catch (err) {
    state.running = false;
    state.started = false;
    handleError(err);
  } finally {
    state.busy = false;
    dom.start.disabled = false;
  }
}

function stop() {
  if (!rig) return;
  rig.stop();
  releaseWakeLock();
  state.running = false;
  setStatus(IS_MOBILE ? '已暂停 · 点 ▶ 继续' : '已暂停 · 空格继续', '');
}

/** ?panel=1 直接把手势面板打开：截图与手工查看布局时用。 */
function maybeOpenPanel() {
  if (params.get('panel') === '1') engine.openSelection();
}

/**
 * 把启动失败翻译成"用户能照着做"的中文提示。
 * 按 DOMException.name 优先（最可靠），message 只作兜底——
 * 例如 Chrome 在没有摄像头时只给 "Requested device not found"（NotFoundError）。
 */
function describeFailure(err) {
  const name = err?.name || '';
  const message = err?.message || String(err);
  const has = (re) => re.test(message);

  if (name === 'NotFoundError' || has(/Requested device not found|no camera|devices? not found/i)) {
    return {
      title: '没有检测到摄像头',
      text:
        '系统没有把任何摄像头交给浏览器，所以没法开始手势识别。按顺序检查：' +
        '① 设备管理器里「相机 / Integrated Camera」是否带黄色感叹号——有问题就右键「卸载设备」再「扫描检测硬件改动」，或者直接重启电脑；' +
        '② 笔记本的摄像头快捷键（常见 Fn+F8/F10）或镜头上的物理隐私挡板是否把它关了；' +
        '③ 插上 USB 摄像头后回到这里点「重试」。',
    };
  }
  if (name === 'NotAllowedError' || has(/Permission|NotAllowed|denied/i)) {
    return {
      title: '摄像头权限被拒绝',
      text: '点地址栏左侧的图标（锁 / 摄像头）→ 把「摄像头」改成「允许」，然后点「重试」。',
    };
  }
  if (name === 'NotReadableError' || has(/NotReadable|TrackStart|could not start/i)) {
    return {
      title: '摄像头被占用',
      text: '别的程序正拿着摄像头（相机、微信、腾讯会议、OBS 等）。把它关掉再点「重试」。',
    };
  }
  if (name === 'OverconstrainedError' || has(/Overconstrained/i)) {
    return {
      title: '摄像头不支持这个分辨率',
      text: '试试换个摄像头，或关掉占用它的程序后点「重试」。',
    };
  }
  if (name === 'SecurityError' || has(/insecure|secure context/i)) {
    return {
      title: '请通过本机服务器打开',
      text: '浏览器只允许 http://localhost 这类安全上下文访问摄像头。运行 python serve.py 再打开 http://localhost:8000/ 。',
    };
  }
  if (has(/模型|model|\.task/i)) {
    return {
      title: '模型文件加载失败',
      text: '确认 vendor/models/*.task 存在（可运行 python tools/get_models.py 重新下载）。',
    };
  }
  if (has(/WebGL|delegate|wasm|WASM|fetch|Failed to fetch|dynamically imported/i)) {
    return {
      title: 'MediaPipe 初始化失败',
      text: '素材没能加载。请通过本机服务器打开页面（不是 file://），并确认 vendor/ 目录完整。',
    };
  }
  return { title: '出错了', text: message };
}

function handleError(err) {
  const message = err?.message || String(err);
  console.error('[airwrite]', err);
  const { title, text } = describeFailure(err);
  dom.errorTitle.textContent = title;
  dom.errorText.textContent = text;
  dom.errorDetail.textContent = message;
  dom.errorDetail.hidden = !/Error|error:|Uncaught/.test(message);
  showCard('error');
  setStatus(`出错了 · ${title}`, 'err');
}

/* -------------------------------------------------------------- 面板 --- */

/** 屏幕上的一点 -> 视频归一化坐标（引擎与 landmarks 用的坐标系）。
    画布不做 CSS 翻转，所以屏幕 x 与画布内部 x 一致，直接反投影即可。 */
function toVideoPoint(clientX, clientY) {
  const rect = dom.overlay.getBoundingClientRect();
  return mapper.unproject(clientX - rect.left, clientY - rect.top);
}

function panelItemAt(clientX, clientY) {
  const rect = dom.overlay.getBoundingClientRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  for (const item of renderer.panelRects || []) {
    if (cssX >= item.x && cssX <= item.x + item.w && cssY >= item.y && cssY <= item.y + item.h) return item;
  }
  return null;
}

let pointerDrawing = false;

function wirePointer() {
  dom.overlay.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // 合成事件（QA）没有活跃指针，setPointerCapture 会抛 InvalidPointerId——别让它拦住后续逻辑
    try {
      dom.overlay.setPointerCapture?.(ev.pointerId);
    } catch {
      /* 指针捕获失败不影响绘制 */
    }
    const now = performance.now();
    if (engine.state.selectionMode) {
      const item = panelItemAt(ev.clientX, ev.clientY);
      if (item) engine.applyPanelSelection(item);
      return;
    }
    if (engine.state.tool !== 'pen') return;
    const point = toVideoPoint(ev.clientX, ev.clientY);
    pointerDrawing = engine.pointerDown(point, now);
  });

  dom.overlay.addEventListener('pointermove', (ev) => {
    if (!pointerDrawing) return;
    engine.pointerMove(toVideoPoint(ev.clientX, ev.clientY), performance.now());
  });

  const finish = () => {
    if (!pointerDrawing) return;
    pointerDrawing = false;
    engine.pointerUp(performance.now());
  };
  dom.overlay.addEventListener('pointerup', finish);
  dom.overlay.addEventListener('pointercancel', finish);
  dom.overlay.addEventListener('pointerleave', finish);
}

/* ------------------------------------------------------------- 全屏 --- */

function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    if (!el.requestFullscreen) {
      // iOS Safari 没有元素级全屏：告诉用户替代方案，别静默失败。
      flashHint(IS_IOS ? 'iPhone 上请用 Safari 的「添加到主屏幕」获得全屏体验' : '这个浏览器不支持网页全屏');
      return;
    }
    el.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
}

/* ------------------------------------------------------------ 接线 --- */

/** 切换镜像。摄像头（自拍）默认开，演示模式默认关——演示没有摄像头，翻转只会让字形反。 */
function setMirrored(on) {
  state.mirrored = !!on;
  dom.stage.classList.toggle('mirror', state.mirrored);
  dom.mirror.classList.toggle('on', state.mirrored);
}

function wire() {
  dom.start.onclick = () => (state.running ? stop() : start(state.source));
  dom.undo.onclick = () => engine.undo();
  dom.clear.onclick = () => engine.clear();
  dom.mirror.onclick = () => setMirrored(!state.mirrored);
  dom.full.onclick = toggleFullscreen;
  dom.help.onclick = () => showCard(state.lastCard === 'help' ? null : 'help');
  dom.helpClose.onclick = () => showCard(null);

  dom.begin.onclick = () => start('camera');
  dom.demo.onclick = () => start('demo');
  dom.errorRetry.onclick = () => start(state.source === 'demo' ? 'demo' : 'camera');
  dom.errorDemo.onclick = () => start('demo');
  dom.errorClose.onclick = () => showCard(null);

  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('full', !!document.fullscreenElement);
    resize();
  });

  engine.on('selection', ({ active }) => {
    document.body.classList.toggle('selecting', active);
    if (active) setStatus('选择工具：食指悬停 0.7 秒确认', 'busy');
    else setStatus(state.running ? '运行中' : '已暂停', state.running ? 'ok' : '');
  });
  engine.on('tool', syncChips);
  engine.on('stroke', syncChips);
  engine.on('erase', syncChips);
  engine.on('character', syncChips);
  engine.on('status', ({ text }) => flashHint(text));

  window.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    const key = ev.key.toLowerCase();
    if (key === ' ') {
      ev.preventDefault();
      state.running ? stop() : start(state.source);
    } else if (key === 'z') engine.undo();
    else if (key === 'x') engine.clear();
    else if (key === 'm') dom.mirror.onclick();
    else if (key === 'f') toggleFullscreen();
    else if (key === 'h') dom.help.onclick();
    else if (key === 'p') engine.toggleSelection();
    else if (key === 'escape' && state.lastCard) showCard(null);
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  window.addEventListener('beforeunload', () => rig?.dispose());

  // 触屏设备没有"全屏"按钮可点（iOS 尤其不支持元素全屏），藏掉比点了没反应好。
  if (!document.documentElement.requestFullscreen) {
    dom.full.hidden = true;
    dom.full.setAttribute('aria-hidden', 'true');
  }
  // 键盘快捷键在手机上不存在：把说明卡里那一行藏起来（纯 CSS 也能做，这里一并标记）。
  if (IS_MOBILE) document.body.classList.add('touch');

  // 从后台回来时重新申请屏幕常亮（wake lock 在切后台时会被系统释放）。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.running) acquireWakeLock();
  });
}

/* ------------------------------------------------------------ 预检 --- */

function preflight() {
  if (location.protocol === 'file:') {
    dom.errorTitle.textContent = '请通过服务器打开';
    dom.errorText.textContent = IS_MOBILE
      ? '浏览器不允许 file:// 页面访问摄像头。用下面这个网址打开（HTTPS 或 localhost 都行）。'
      : '浏览器不允许 file:// 页面访问摄像头。在项目目录运行 python serve.py，然后访问 http://localhost:8000/ 。';
    dom.errorDetail.textContent = 'file:// 下 getUserMedia 不可用';
    dom.errorDetail.hidden = false;
    showCard('error');
    setStatus(IS_MOBILE ? '需要通过 https 打开' : '需要通过 http://localhost 打开', 'err');
    return false;
  }
  // 手机上用局域网 http://192.168.x.x 打开时，浏览器会以"非安全上下文"为由直接拒绝摄像头。
  const secure = location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!secure) {
    dom.errorTitle.textContent = '手机需要 HTTPS 地址';
    dom.errorText.textContent =
      '浏览器只允许 HTTPS（或 localhost）页面打开摄像头。局域网 http://192.168… 会被拒绝 —— 用部署到 GitHub Pages 的 https 网址即可。';
    dom.errorDetail.textContent = `insecure context: ${location.href}`;
    dom.errorDetail.hidden = false;
    showCard('error');
    setStatus('需要 https 才能用摄像头', 'err');
    return false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('这个浏览器不支持摄像头，可先用演示模式', 'err');
    return false;
  }
  setStatus(IS_MOBILE ? '准备好了 · 点「开启摄像头」' : '准备好了 · 点“开启摄像头”', '');
  return true;
}

/* ------------------------------------------------------------ 调试钩子 --- */

/** ?qa=1 时跑一个页面级自检清单并把结果写进 <pre id="result">，
    交给 tools/run_selftest.py 在 headless Edge 里读取。 */
const QA = params.get('qa') === '1';
const qaBudget = Number(params.get('qaFrames') || 150);
/** ?qaExpect=error：断言"启动失败时给人的提示"这一条路径。
 *  headless 里没有摄像头，getUserMedia 会抛 NotFoundError——正好复现用户的真实故障。 */
const qaExpectError = params.get('qaExpect') === 'error';
let renderedFrames = 0;
let qaTimer = 0;
let qaIdleTicks = 0;

/** 两层画布缩略成 160×100，数一数有多少不透明的像素——"真的画出东西了吗"。 */
function sampleLitPixels() {
  const w = 160;
  const h = 100;
  if (!sampleLitPixels.canvas) {
    sampleLitPixels.canvas = document.createElement('canvas');
    sampleLitPixels.canvas.width = w;
    sampleLitPixels.canvas.height = h;
    sampleLitPixels.ctx = sampleLitPixels.canvas.getContext('2d', { willReadFrequently: true });
  }
  const ctx = sampleLitPixels.ctx;
  ctx.clearRect(0, 0, w, h);
  for (const surface of [dom.ink, dom.overlay]) {
    if (surface) ctx.drawImage(surface, 0, 0, w, h);
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) lit += 1;
  return lit;
}

/** QA：在面板上真点一下"缩放"，走完 命中测试 → applyPanelSelection 整条链路。
    只有 ?qaClick=panel 时才做——点完会切到缩放并收面板，截图那一跑不能带上它。 */
function qaPanelClick() {
  if (!QA || params.get('qaClick') !== 'panel') return null;
  const rects = renderer.panelRects || [];
  const target = rects.find((r) => r.id === 'tool-zoom');
  if (!target) return { ok: false, detail: 'panelRects 里没有 tool-zoom' };
  const wasSelecting = engine.selection.active;
  const box = dom.overlay.getBoundingClientRect();
  dom.overlay.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: box.left + target.x + target.w / 2,
      clientY: box.top + target.y + target.h / 2,
      button: 0,
      bubbles: true,
    }),
  );
  return {
    ok: engine.state.tool === 'zoom',
    detail: `tool=${engine.state.tool} rects=${rects.length} 选择模式=${wasSelecting}`,
  };
}

function qaFinish() {
  clearInterval(qaTimer);
  const clicked = qaExpectError ? null : qaPanelClick();
  const snap = globalThis.__airwrite.snapshot();
  let checks;
  if (qaExpectError) {
    // 失败路径也要有断言：提示必须是"能照做的中文"，而不是把原始英文丢给用户。
    const card = snap.errorCard || {};
    checks = [
      ['启动失败时弹出了错误卡片', snap.error === true],
      ['有可执行的提示文字', (card.text || '').length > 20],
      ['标题是中文诊断（不是原始英文）', /[\u4e00-\u9fa5]/.test(card.title || ''), card.title],
      ['正文不再是原始英文消息', (card.text || '') !== (card.detail || '~')],
      ['卡片给了「改用演示模式」兜底', !!dom.errorDemo && !dom.errorDemo.hidden],
      ['状态栏也进入错误态', /出错/.test(snap.status)],
    ];
  } else {
    checks = [
      ['引擎在跑', snap.running === true],
      ['收到了帧', snap.frames > 0],
      ['画布已按视口初始化', snap.canvas.width > 0 && snap.canvas.height > 0],
      ['手势面板有格子', snap.panelItems >= 11],
      ['缩放初始为 1', Math.abs(snap.zoom - 1) < 1e-6],
      ['没有弹出错误卡片', snap.error === false],
      ['状态栏进入运行态', /运行中|演示|选择/.test(snap.status)],
      ['画布上真的画出了东西', snap.lit > 20],
      ['画布没有被 CSS 翻转（中文才不会镜像）', getComputedStyle(dom.overlay).transform === 'none'],
    ];
  }
  if (clicked) checks.push(['点面板上的“缩放”真的选中了', clicked.ok, clicked.detail]);
  if (snap.source === 'camera' && !qaExpectError) {
    checks.push(['摄像头画面可用', snap.video.width > 0 && snap.video.height > 0]);
  }
  const failures = checks
    .filter(([, ok]) => !ok)
    .map(([name, , detail]) => ({ name, detail: detail || '' }));
  const summary = {
    page: 'index.html',
    source: snap.source,
    passed: checks.length - failures.length,
    total: checks.length,
    failed: failures.length,
    failures,
    snapshot: snap,
    panelClick: clicked,
  };
  document.title = `AIRWRITE-APP ${failures.length ? 'FAIL' : 'PASS'} ${summary.passed}/${summary.total} src=${snap.source} frames=${snap.frames}`;
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(summary);
  document.body.append(pre);
  // 有服务器时把结果回传：摄像头模式没法用 --dump-dom（虚拟时间会被 getUserMedia 挂住）
  // qaName 让同一次跑里多个用例共用 source=camera 时也能各自取到自己的结果。
  try {
    fetch(`/__result/${params.get('qaName') || snap.source}`, { method: 'POST', body: JSON.stringify(summary) }).catch(() => {});
  } catch {
    /* 静态服务器没实现 POST 也无所谓：#result 还在 DOM 里 */
  }
}

function qaTick() {
  if (!QA) return;
  if (renderedFrames === qaBudget) qaFinish();
}

globalThis.__airwrite = {
  get rig() {
    return rig;
  },
  engine,
  renderer,
  mapper,
  state,
  demoFrames,
  start,
  stop,
  toVideoPoint,
  snapshot() {
    const results = rig?.results || {};
    const size = rig?.videoSize || { width: 0, height: 0 };
    return {
      running: state.running,
      source: state.source,
      demo: !!rig?.isDemo,
      mirror: state.mirrored,
      fps: Math.round(rig?.fps || 0),
      frames: renderedFrames,
      video: { width: size.width || 0, height: size.height || 0 },
      hands: (results.hands || []).map((h) => ({
        label: h.label,
        pinch: Number((h.pinch ?? 0).toFixed(3)),
        key: h.key || null,
      })),
      tool: engine.state.tool,
      color: engine.state.color,
      size: engine.state.size,
      eraserSize: engine.state.eraserSize,
      strokes: engine.strokes.length,
      characters: engine.characters.map((c) => ({ text: c.text, reason: c.reason, ready: !!c.ready })),
      selection: engine.selection.active,
      panelItems: engine.toolLayout?.items?.length || 0,
      zoom: Number(engine.zoom.level.toFixed(3)),
      snow: engine.snowParticles.length,
      // 引擎视角的手势判定（掌心/手背/是否散字姿态），排查"扫不动"用
      engineHands: engine.hands,
      snowParticle: engine.snowParticles.slice(0, 6).map((p) => ({
        x: Number(p.x.toFixed(4)),
        y: Number(p.y.toFixed(4)),
        size: Number((p.size || 0).toFixed(2)),
        depth: Number((p.depth ?? 0).toFixed(2)),
        variant: p.variant ?? 0,
        alpha: Number(engine.snowAlpha(p).toFixed(3)),
      })),
      canvas: { width: dom.overlay.width, height: dom.overlay.height },
      view: { w: renderer.width, h: renderer.height, ratio: renderer.ratio, aspect: Number((renderer.width / Math.max(1, renderer.height)).toFixed(3)) },
      panel: (renderer.panelRects || []).map((r) => ({
        id: r.id,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.w),
        h: Math.round(r.h),
      })),
      lit: sampleLitPixels(),
      mapper: {
        pixelScale: Number((mapper.pixelScale || 0).toFixed(3)),
        videoWidth: mapper.videoWidth,
        videoHeight: mapper.videoHeight,
        canvasWidth: mapper.canvasWidth,
        canvasHeight: mapper.canvasHeight,
        zoom: mapper.zoom,
      },
      status: dom.statusText.textContent,
      error: !dom.errorCard.hidden,
      errorCard: dom.errorCard.hidden
        ? null
        : {
            title: dom.errorTitle.textContent,
            text: dom.errorText.textContent,
            detail: dom.errorDetail.textContent,
          },
    };
  },
};

/* --------------------------------------------------------------- 启动 --- */

wire();
wirePointer();
syncChips();
preflight();
resize();
if (params.get('help') === '1') showCard('help');
else if (params.get('panel') === '1' || params.get('autostart') === '1') showCard(null);
else showCard('start');

if (params.get('autostart') === '1') {
  globalThis.addEventListener('load', () => start(state.source));
}

if (QA) {
  // headless Chromium 没有可见画面时不会触发 rAF，而虚拟时间下定时器会全速推进：
  // 所以自检模式改用手动步进（Rig.step）驱动与真机完全相同的每帧路径。
  qaTimer = setInterval(() => {
    if (state.running && rig) {
      rig.step();
    } else if (qaExpectError) {
      // 摄像头不存在时引擎永远不会 running，收尾只能靠独立计数——
      // 否则这条失败路径永远不产出结果，等于没有回归测试。
      qaIdleTicks += 1;
      if (qaIdleTicks > 60 && !state.busy && !state.running) qaFinish();
    }
  }, 16);
}
