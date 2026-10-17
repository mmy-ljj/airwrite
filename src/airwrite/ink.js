/**
 * Ink model for air writing: turns a stream of pen samples into strokes, and
 * groups strokes into characters that the recognizer can consume.
 *
 * Coordinate space is whatever the caller feeds in (we use CSS pixels of the
 * stage), so the recorder is independent of camera resolution and window size.
 *
 * Lifecycle:
 *   begin(x, y, t) -> move(x, y, t) ... -> end(t)      one stroke
 *   strokes accumulate into the current character until:
 *     * a gap longer than `gapMs` passes between strokes, or
 *     * `breakCharacter()` is called, or
 *     * the character grows past `maxStrokes`/`maxExtent`.
 *   Finished characters are handed to `onCharacter`.
 */

import { pointsBounds, polylineLength } from '../vision/smoothing.js';

export const DEFAULTS = {
  /** Minimum spacing between recorded samples, in px. */
  minSampleDistance: 1.6,
  /** Ignore strokes shorter than this (px) so jitter does not create ink. */
  minStrokeLength: 14,
  /** Soft cap on samples per stroke. */
  maxSamplesPerStroke: 1400,
  /** Gap between strokes that closes a character. */
  gapMs: 1100,
  /** Auto-close a character that somehow never ends. */
  maxStrokeDurationMs: 6000,
  /** Strokes allowed in one character (E = 4, 我 is more). */
  maxStrokes: 8,
  /** If a character box grows beyond this (px) the next stroke starts a new one. */
  maxExtent: 900,
  /**
   * 单帧位移超过这个距离（归一化画面比例）就判定为"追踪跳变"，不是真的在画。
   *
   * MediaPipe 在遮挡/快速移动/光线突变时会偶发把手的坐标瞬间甩到画面另一处。
   * 没有这道闸的话，这一跳会被当成正常采样追加进笔迹，在作品上拉出一条横贯
   * 全屏的直线 —— 用户看到的就是"字突然被划了一刀"。
   * 处理方式按"真正的笔会怎么做"来：抬笔，然后在新的位置重新落笔，笔迹断开。
   * 阈值取 0.25（画面短边的 1/4）：正常手写即便很快也达不到，只有跳变会触发。
   */
  maxJumpDistance: 0.25,
  maxCharacters: 40,
};

let nextMarkId = 1;

export function createInkRecorder(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  /** Completed marks (immutable snapshots), oldest first. */
  let marks = [];
  /** The stroke currently being drawn, or null. */
  let live = null;
  /** Strokes of the character under construction. */
  const pending = [];
  let lastStrokeEnd = 0;
  let characterIndex = 0;
  let seq = 0;

  const listeners = { character: [], change: [] };

  const emit = (name, payload) => {
    for (const fn of listeners[name]) fn(payload);
  };

  /**
   * 注意：必须是一个真正的函数声明，不能只把 stats 写成返回对象上的方法 ——
   * notify() 在对象字面量之外调用它，写成对象方法会直接 ReferenceError，
   * 于是第一次 begin() 就抛异常，整条写字链路一行墨都画不出来。
   */
  function stats() {
    return {
      marks: marks.length,
      live: live ? live.points.length : 0,
      pendingStrokes: pending.length,
      strokes: marks.length,
      inkLength: marks.reduce((sum, m) => sum + m.length, 0),
    };
  }

  function notify() {
    emit('change', stats());
  }

  function closeCharacter(reason = 'gap') {
    if (!pending.length) return null;
    const strokes = pending.splice(0, pending.length);
    const character = {
      id: characterIndex++,
      seq: seq++,
      strokes,
      reason,
      createdAt: performance.now(),
      bounds: pointsBounds(strokes.flat()),
    };
    emit('character', character);
    notify();
    return character;
  }

  function pendingBounds() {
    const pts = pending.flat();
    return pts.length ? pointsBounds(pts) : { width: 0, height: 0, minX: 0, minY: 0 };
  }

  function maybeExpire(now) {
    if (!pending.length) return;
    /*
     * 正在写的那一笔不允许被"停顿计时"截断。
     * tick() 每帧都会走到这里，而 lastStrokeEnd 只在 end() 时更新：如果不管 live，
     * 那么只要一笔写得比 gapMs(1100ms) 久，笔画还没写完，上一笔就被判成"停顿超时"，
     * 多笔字（H/I/A）必然被拆成一笔一个字。暂停只在"两笔之间"才允许触发分字。
     */
    if (live) return;
    if (now - lastStrokeEnd > cfg.gapMs) closeCharacter('gap');
  }

  return {
    get marks() {
      return marks;
    },
    get live() {
      return live;
    },
    get pending() {
      return pending;
    },
    get config() {
      return cfg;
    },

    /**
     * 按 id 删除笔迹（同时从 pending 里摘掉，避免被擦掉的笔画还参与识别）。
     *
     * 必须走这个方法，不能在外部写 `ink.marks = ...`：`marks` 是闭包里的 `let`，
     * 对外只有 getter —— 模块是严格模式，赋值会直接抛
     * `TypeError: Cannot set property marks of #<Object> which has only a getter`，
     * 而它发生在每帧的 update 里，等于整个交互从此卡死（浏览器自检抓到的就是这个）。
     */
    removeMarks(ids) {
      const set = ids instanceof Set ? ids : new Set(ids);
      if (!set.size) return 0;
      const before = marks.length;
      marks = marks.filter((mark) => !set.has(mark.id));
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (set.has(pending[i].id)) pending.splice(i, 1);
      }
      const removed = before - marks.length;
      if (removed) notify();
      return removed;
    },

    /** Start a stroke. `style` = { tool, color, width }. */
    begin(x, y, now = performance.now(), style = {}) {
      maybeExpire(now);
      // A very long pause, too many strokes, or a huge bounding box means the
      // previous character is finished.
      if (pending.length) {
        const bounds = pendingBounds();
        if (
          now - lastStrokeEnd > cfg.gapMs ||
          pending.length >= cfg.maxStrokes ||
          Math.max(bounds.width, bounds.height) > cfg.maxExtent
        ) {
          closeCharacter('limit');
        }
      }
      live = {
        id: nextMarkId++,
        tool: style.tool === 'eraser' ? 'eraser' : 'pen',
        color: style.color || '#6ee7ff',
        width: style.width || 6,
        startedAt: now,
        points: [{ x, y, t: now }],
      };
      notify();
      return live;
    },

    /** Append a sample to the live stroke. Returns true when a point was kept. */
    move(x, y, now = performance.now()) {
      if (!live) return false;
      const points = live.points;
      const last = points[points.length - 1];
      const dist = Math.hypot(x - last.x, y - last.y);

      /*
       * 追踪跳变闸门：这一跳不是笔画，是 landmark 甩了。
       * 先把当前笔画收尾（过短的会被 end() 丢弃），再在新位置重新落笔，
       * 这样断开的两截各自是合理的笔画，而不是一条横贯画面的直线。
       */
      if (dist > cfg.maxJumpDistance) {
        const style = { tool: live.tool, color: live.color, width: live.width };
        this.end(now);
        this.begin(x, y, now, style);
        return true;
      }

      if (dist < cfg.minSampleDistance && points.length > 2) return false;
      if (points.length >= cfg.maxSamplesPerStroke) return false;
      points.push({ x, y, t: now });
      if (live.tool === 'pen' && now - live.startedAt > cfg.maxStrokeDurationMs) {
        this.end(now);
      }
      return true;
    },

    /** Finish the live stroke and commit it (either as ink or as an eraser hit). */
    end(now = performance.now()) {
      if (!live) return null;
      const stroke = live;
      live = null;
      lastStrokeEnd = now;

      if (stroke.tool === 'eraser') {
        const removed = eraseAlongStroke(stroke);
        notify();
        return { erased: removed };
      }

      const length = polylineLength(stroke.points);
      if (length < cfg.minStrokeLength || stroke.points.length < 2) {
        notify();
        return null;
      }

      const mark = {
        id: stroke.id,
        tool: 'pen',
        color: stroke.color,
        width: stroke.width,
        startedAt: stroke.startedAt,
        endedAt: now,
        length,
        points: stroke.points,
      };
      marks = [...marks, mark];
      pending.push(mark);
      notify();
      return mark;
    },

    /** 最近一笔的收笔时间；引擎用它判断"刚提笔"（见 drawCooldownMs）。 */
    get lastStrokeEnd() {
      return lastStrokeEnd;
    },

    /** Explicitly start a new character (used by the "换字" action / pen-up pause). */
    breakCharacter(reason = 'manual') {
      if (live) this.end();
      return closeCharacter(reason);
    },

    /** Called every frame so a long pause closes the character without new ink. */
    tick(now = performance.now()) {
      maybeExpire(now);
    },

    /** Remove the last stroke (undo) from the live/pending/history area. */
    undo() {
      if (live) {
        live = null;
        notify();
        return 'live';
      }
      if (pending.length) {
        const removed = pending.pop();
        marks = marks.filter((m) => m.id !== removed.id);
        notify();
        return 'pending';
      }
      if (marks.length) {
        const removed = marks.pop();
        notify();
        return 'history';
      }
      return null;
    },

    clear() {
      marks = [];
      live = null;
      pending.length = 0;
      lastStrokeEnd = 0;
      notify();
      return true;
    },

    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
      return () => {
        const list = listeners[event];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },

    stats,
  };

  /** Delete every mark whose ink passes within the eraser radius. */
  function eraseAlongStroke(eraser) {
    const radius = Math.max(8, eraser.width);
    const hits = [];
    for (const mark of marks) {
      if (markEraserHit(mark, eraser.points, radius)) hits.push(mark.id);
    }
    if (!hits.length) return 0;
    const hitSet = new Set(hits);
    marks = marks.filter((m) => !hitSet.has(m.id));
    // Also drop hits from the pending character so they cannot be recognised.
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (hitSet.has(pending[i].id)) pending.splice(i, 1);
    }
    return hits.length;
  }

  function markEraserHit(mark, eraserPoints, radius) {
    const r2 = radius * radius;
    // Coarse then fine: bounding box first, then point-to-point distance with a
    // stride of 2 (eraser strokes are dense, misses by 1 sample are invisible).
    const bounds = pointsBounds(mark.points);
    const eraserBounds = pointsBounds(eraserPoints);
    if (
      eraserBounds.maxX + radius < bounds.minX ||
      eraserBounds.minX - radius > bounds.maxX ||
      eraserBounds.maxY + radius < bounds.minY ||
      eraserBounds.minY - radius > bounds.maxY
    ) {
      return false;
    }
    for (let i = 0; i < mark.points.length; i += 2) {
      const p = mark.points[i];
      for (let j = 0; j < eraserPoints.length; j += 2) {
        const e = eraserPoints[j];
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        if (dx * dx + dy * dy <= r2) return true;
      }
    }
    return false;
  }
}
