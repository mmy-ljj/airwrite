/**
 * Rig: one camera feed + one rAF loop + a registry of MediaPipe feature trackers.
 *
 * Design notes
 * ------------
 * - The camera stream is owned by the rig. Feature trackers never touch it.
 * - Coordinates: this module is pure data. Screen mapping happens in overlay.js
 *   so that display options (mirror, aspect, zoom) never leak into detection.
 * - `mirrorPreview` flips the <video> AND the overlay canvas together, so the
 *   overlay can keep drawing unflipped normalized coordinates. Handedness
 *   labels are corrected where they are produced (vision/hands.js), because
 *   the model is fed the unmirrored <video> and reports mirror-image labels;
 *   this module stays pure data and never rewrites tracker output.
 * - Mobile: the loop stops while the page is hidden (camera LED + battery),
 *   inference is capped to `maxInferFps` (phones thermally throttle long
 *   before desktops), and `openCamera` degrades its constraints instead of
 *   failing outright when a phone refuses 1280×720. iOS may also refuse to
 *   play the stream outside a user gesture — that surfaces as
 *   `needsGesture`, which the UI turns into a single "tap to continue".
 */

/** @typedef {'hands'|'pose'|'face'|'gestures'} FeatureId */

export class Rig {
  /** @type {Map<string, object>} */
  #trackers = new Map();
  #video;
  #running = false;
  #rafId = 0;
  #lastTs = -1;
  #frames = 0;
  #fps = 0;
  #fpsWindowStart = 0;
  #listeners = new Set();
  #lastResults = {};
  /** @type {null | ((frame: object) => object)} */
  #demo = null;
  #useDemo = false;
  #lastInferTs = 0;
  #hiddenPaused = false;
  #onVisibility = null;

  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {number} [opts.minDetectionConfidence]
   * @param {number} [opts.maxInferFps] 0 = 不限；手机上建议 30
   */
  constructor({
    video,
    minDetectionConfidence = 0.6,
    minTrackingConfidence = 0.6,
    maxInferFps = 0,
  } = {}) {
    this.#video = video;
    this.settings = { minDetectionConfidence, minTrackingConfidence };
    this.mirrorPreview = true;
    /** 0 = 每帧都推理（桌面）；>0 时按毫秒节流，给手机留出渲染余量。 */
    this.maxInferFps = maxInferFps;
    /** 播放被浏览器的一次性手势要求挡住时为 true，由 UI 提示"点一下"。 */
    this.needsGesture = false;
  }

  get video() {
    return this.#video;
  }

  get running() {
    return this.#running;
  }

  get fps() {
    return this.#fps;
  }

  get videoSize() {
    return { width: this.#video.videoWidth || 0, height: this.#video.videoHeight || 0 };
  }

  /** @returns {object} last frame's results keyed by feature id */
  get results() {
    return this.#lastResults;
  }

  /**
   * Register a tracker. A tracker is `{ id, init(rig), detect(video, ts), adapt(raw, rig) }`.
   * @param {{id: string, init: Function, detect: Function, adapt: Function}} tracker
   */
  register(tracker) {
    this.#trackers.set(tracker.id, tracker);
  }

  /**
   * Use a synthetic frame generator instead of MediaPipe. `generator(frame)`
   * returns the same shape as `onFrame` results (without `ts`/`frame`), so the
   * whole render path can be exercised with no camera and no model files.
   */
  setDemoGenerator(generator) {
    this.#demo = generator;
  }

  /** Is the loop currently driven by the synthetic generator? */
  get isDemo() {
    return typeof this.#demo === 'function' && this.#useDemo;
  }

  /**
   * Switch the frame source.
   * @param {'camera'|'demo'} source
   */
  async setSource(source) {
    const demo = source === 'demo';
    if (demo && typeof this.#demo !== 'function') {
      throw new Error('no synthetic frame generator registered');
    }
    this.#useDemo = demo;
    this.#lastTs = -1;
    if (demo) {
      this.#video.pause();
      if (this.#video.srcObject) {
        for (const track of this.#video.srcObject.getTracks()) track.stop();
        this.#video.srcObject = null;
      }
    } else if (this.stream) {
      this.#video.srcObject = this.stream;
      await this.#video.play().catch(() => {});
    }
    for (const tracker of this.#trackers.values()) tracker.onSourceChange?.(source);
  }

  /**
   * Open the webcam. Kept separate from start() so callers can show a
   * permission prompt / error surface without racing the detection loop.
   *
   * Constraints degrade instead of failing: some phones refuse 1280×720 or a
   * hard `facingMode`, and a 640×480 selfie feed is still perfectly usable.
   * @param {MediaTrackConstraints} [constraints]
   * @returns {Promise<{width: number, height: number, needsGesture: boolean}>}
   */
  async openCamera(constraints = {}) {
    const video = this.#video;
    // iOS 只在带 playsinline/muted 时才内联播放；属性已经写在 index.html 里，
    // 这里再兜一层，防止有人把 <video> 换掉。
    video.muted = true;
    video.playsInline = true;
    const attempts = [
      { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 }, ...constraints },
      { facingMode: { ideal: 'user' } },
      {},
    ];
    let stream = null;
    let lastErr = null;
    for (const videoConstraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
        break;
      } catch (err) {
        lastErr = err;
        const fatal = err && ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError'].includes(err.name);
        if (fatal) break;
      }
    }
    if (!stream) throw lastErr || new Error('camera unavailable');

    this.stream = stream;
    video.srcObject = stream;
    this.needsGesture = false;
    try {
      await video.play();
    } catch {
      // Safari 有时要求播放发生在用户手势里：把这件事告诉 UI，由它提示点一下。
      this.needsGesture = true;
    }

    let size = { width: video.videoWidth || 0, height: video.videoHeight || 0 };
    if (this.needsGesture) return { ...size, needsGesture: true };
    try {
      await this.#waitForVideo(6000);
    } catch {
      // 流已经建立但一直没有帧：多半也是被挡住的播放。
      this.needsGesture = true;
    }
    size = { width: video.videoWidth || 0, height: video.videoHeight || 0 };
    return { ...size, needsGesture: false };
  }

  /** 用户点了一下画面：把被浏览器挡住的那次 play() 补上。 */
  async resume() {
    try {
      await this.#video.play();
      this.needsGesture = false;
      return true;
    } catch {
      return false;
    }
  }

  /** 等待首帧到达（公开版，#waitForVideo 给内部与 UI 的"点一下继续"复用）。 */
  waitForFrames(timeoutMs = 8000) {
    return this.#waitForVideo(timeoutMs).then(() => this.videoSize);
  }

  #waitForVideo(timeoutMs = 8000) {
    const video = this.#video;
    if (video.videoWidth > 0) return Promise.resolve({ width: video.videoWidth, height: video.videoHeight });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup();
        reject(new Error('camera produced no frames (is another app using it?)'));
      }, timeoutMs);
      const onReady = () => {
        if (video.videoWidth > 0) {
          cleanup();
          resolve({ width: video.videoWidth, height: video.videoHeight });
        }
      };
      const cleanup = () => {
        clearTimeout(t);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('timeupdate', onReady);
      };
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('timeupdate', onReady);
    });
  }

  /**
   * Initialise every registered tracker (loads wasm + models).
   *
   * 每个 tracker 的进度通过 onProgress 透传（`{phase, id, ratio, ...}`），
   * UI 靠它显示「模型 xx%」——手机上下 17 MB 不显示进度就像卡死。
   */
  async load(onProgress = () => {}) {
    for (const tracker of this.#trackers.values()) {
      onProgress({ phase: 'init', id: tracker.id });
      await tracker.init(this, (info = {}) => onProgress({ ...info, id: tracker.id }));
    }
    onProgress({ phase: 'ready' });
  }

  /** Start the per-frame loop. */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#fpsWindowStart = performance.now();
    this.#frames = 0;
    this.#lastInferTs = 0;
    // 页面切到后台时停循环（手机上一来省电，二来摄像头轨道可能被系统收回），
    // 回到前台再接着跑；用户自己按的暂停不会被这里覆盖。
    if (typeof document !== 'undefined' && !this.#onVisibility) {
      this.#onVisibility = () => {
        if (document.hidden) {
          if (this.#running) {
            this.#hiddenPaused = true;
            this.stop();
          }
        } else if (this.#hiddenPaused) {
          this.#hiddenPaused = false;
          this.start();
        }
      };
      document.addEventListener('visibilitychange', this.#onVisibility);
    }
    const tick = () => {
      if (!this.#running) return;
      this.#rafId = requestAnimationFrame(tick);
      this.#step();
    };
    this.#rafId = requestAnimationFrame(tick);
  }

  /** Stop the loop but keep the camera open (used by the freeze/pause button). */
  stop() {
    this.#running = false;
    cancelAnimationFrame(this.#rafId);
  }

  /**
   * Advance exactly one frame by hand.
   *
   * rAF is the right clock in a real browser, but headless Chromium never fires
   * it when there is no visible surface, and deterministic tests want frames on
   * demand rather than on wall-clock time. Both use this.
   */
  step() {
    this.#step();
  }

  /** Stop everything and release the camera (the LED goes off). */
  dispose() {
    this.stop();
    if (this.#onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibility);
      this.#onVisibility = null;
    }
    this.#hiddenPaused = false;
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.#video.srcObject = null;
    for (const tracker of this.#trackers.values()) tracker.dispose?.();
  }

  #step() {
    const video = this.#video;
    const needsVideo = !this.#useDemo;
    if (needsVideo && (video.readyState < 2 || video.videoWidth === 0)) return;

    // MediaPipe requires strictly increasing timestamps; rAF can repeat one.
    const ts = performance.now();
    if (ts <= this.#lastTs) return;
    this.#lastTs = ts;

    if (this.#useDemo) {
      const results = { ts, frame: ts / 1000, demo: true, ...this.#demo({ ts }) };
      this.#lastResults = results;
      this.#tickFps(ts);
      for (const fn of this.#listeners) fn(results, this);
      return;
    }

    // 限帧：推理才是热的那一段。手机上跑到 60fps 只会发热降频，
    // 30fps 的追踪对写字完全够用（渲染仍然是每帧跑，画面不卡）。
    const minGapMs = this.maxInferFps > 0 ? 1000 / this.maxInferFps - 2 : 0;
    if (minGapMs && ts - this.#lastInferTs < minGapMs) return;
    this.#lastInferTs = ts;

    const raw = {};
    for (const tracker of this.#trackers.values()) {
      // 模型还没就绪时不要调用 detect：一边放预览一边载模型，画面先出来，
      // 手部追踪晚几百毫秒接上（以前是载完模型才出画面，手机以为卡死）。
      if (typeof tracker.isReady === 'function' && !tracker.isReady()) {
        raw[tracker.id] = null;
        continue;
      }
      try {
        raw[tracker.id] = tracker.detect(video, ts);
      } catch (err) {
        tracker.onError?.(err);
      }
    }

    const results = { ts, frame: video.currentTime };
    for (const tracker of this.#trackers.values()) {
      results[tracker.id] = tracker.adapt(raw[tracker.id], this);
    }
    this.#lastResults = results;

    this.#tickFps(ts);
    for (const fn of this.#listeners) fn(results, this);
  }

  #tickFps(ts) {
    this.#frames += 1;
    if (ts - this.#fpsWindowStart >= 500) {
      this.#fps = Math.round((this.#frames * 1000) / (ts - this.#fpsWindowStart));
      this.#frames = 0;
      this.#fpsWindowStart = ts;
    }
  }

  /**
   * Subscribe to per-frame results. `immediate` replays the last frame so a
   * late subscriber does not render an empty canvas until the next tick.
   */
  onFrame(fn, { immediate = false } = {}) {
    this.#listeners.add(fn);
    if (immediate && this.#lastResults.ts) fn(this.#lastResults, this);
    return () => this.#listeners.delete(fn);
  }
}
