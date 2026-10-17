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

  /* ------------------------------------------------------------------
   * 分字精修（m02798）：光靠"停顿 1.1 秒"一个信号，慢写的多笔字（H / A / 我）
   * 会被一笔一个字，快写的两个字又会被并成一个。真实手写里还有两个信号可用：
   *   - 提笔之后手有没有"走开"：多笔字的下一笔落在上一笔旁边，
   *     换字时手会明显平移；
   *   - 停顿到底有多长：1.1 秒可能只是想下一笔，2.6 秒基本就是收字了。
   * 三个信号组合后：
   *   停顿 < gapMs            → 同一个字
   *   停顿 ≥ gapMs 但手没走远  → 仍然同一个字（慢写的多笔字）
   *   停顿 ≥ resumeGapMs 或手走远 → 换字
   * 已经在 gapMs 处交出去的字如果随后被"接着写"，用 revoke 撤回重新合并。
   * ------------------------------------------------------------------ */

  /** 超过这个停顿一定换字（毫秒）。 */
  resumeGapMs: 2600,
  /**
   * 提笔后手移动超过"这个字的尺寸的这么多倍"就认为在换字。
   * 必须跟着字的大小走：写一个大 A（0.4 宽）时抬笔换笔画的位移本身就有 0.3，
   * 固定阈值会把一个字的笔画判成不同的字。
   */
  travelBreakFrac: 1.25,
  /** 走开距离的绝对下限（小字也至少要挪这么远才算换字）。 */
  travelBreakDistance: 0.22,
  /** "落在旁边"的最小容差：新笔画起点离上一字的包围盒这么近就算同一字。 */
  resumeMarginMin: 0.05,
  /** 容差随字的大小放大（写成字的尺寸的 55%）。 */
  resumeMarginFrac: 0.55,

  /* ---- 追踪跳变：按"隐含速度"而不是单帧距离判定 ---- */
  /** 隐含速度超过近期笔速均值的这么多倍，就当成 landmark 甩飞了。 */
  glitchSpeedFactor: 4.5,
  /**
   * 速度下限（归一化单位/秒）。正常快写每帧 0.03~0.05、也就是 2~4 单位/秒，
   * 所以下限必须明显高于它，否则正常写字会被当成跳变丢掉。
   */
  glitchMinSpeed: 6,
  /** 太小的位移不动它（避免把正常抖动当成跳变丢掉）。 */
  glitchMinDistance: 0.05,
  /** 上一采样点距今超过这么久，就不再用"速度"判断（真实的手也可能瞬间挪位）。 */
  glitchMaxGapMs: 320,
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

  /** 提笔后手累计走开的距离（按离"落笔点"的最大位移算），每次落笔清零。 */
  let travel = 0;
  /** 提笔时笔尖所在位置：travel 的参考点。 */
  let anchor = null;
  /** 刚刚因"停顿"交出去的那个字：随后接着写可撤回合并。 */
  let recentClose = null;
  /** 诊断计数（自检与排查用）。 */
  let dropped = 0;
  let revoked = 0;

  const listeners = { character: [], change: [], revoke: [] };

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
      /** 分字诊断：被当成追踪跳变丢掉的采样数、被撤回合并的字数。 */
      dropped,
      revoked,
      travel,
    };
  }

  function notify() {
    emit('change', stats());
  }

  function closeCharacter(reason = 'gap') {
    if (!pending.length) return null;
    const strokes = pending.splice(0, pending.length);
    const bounds = strokesBounds(strokes);
    const character = {
      id: characterIndex++,
      seq: seq++,
      strokes,
      reason,
      createdAt: performance.now(),
      bounds,
    };
    // 因为"停顿"交出去的字先留一手：用户只是慢慢写多笔字的话，
    // 下一笔落下来时要能把这堆笔迹收回来继续合字（见 begin 的 revoke）。
    recentClose = reason === 'gap' ? { character, at: lastStrokeEnd } : null;
    emit('character', character);
    notify();
    return character;
  }

  /*
   * pending 里存的是"笔迹对象"（{id, points, ...}），不是点。要算包围盒必须先把
   * 每一笔的 points 摊平 —— 直接 `pending.flat()` 拿到的是笔迹对象本身，它们没有
   * x/y，于是包围盒永远是 0（"走开多远"的阈值退化成硬编码下限 0.22，A/H/I 这类
   * 两笔字在提笔时手稍微动一下就被判成换字）。
   */
  function strokesBounds(strokes) {
    const pts = [];
    for (const mark of strokes) {
      const list = mark && mark.points ? mark.points : mark || [];
      for (const p of list) pts.push(p);
    }
    return pts.length ? pointsBounds(pts) : { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  function pendingBounds() {
    return strokesBounds(pending);
  }

  /** 点 (x,y) 到包围盒的距离；在盒内为 0。 */
  function distanceToBounds(x, y, bounds) {
    if (!bounds) return Infinity;
    const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
    const dy = y < bounds.minY ? bounds.minY - y : y > bounds.maxY ? y - bounds.maxY : 0;
    return Math.hypot(dx, dy);
  }

  /** "落在旁边"的容差：随字的大小放大，但至少 resumeMarginMin。 */
  function resumeMargin(bounds) {
    const size = bounds ? Math.max(bounds.width, bounds.height) : 0;
    return Math.max(cfg.resumeMarginMin, cfg.resumeMarginFrac * size);
  }

  /** "手走开了"的距离阈值：同样跟着字的大小缩放。 */
  function travelLimit(bounds) {
    const size = bounds ? Math.max(bounds.width, bounds.height) : 0;
    return Math.max(cfg.travelBreakDistance, cfg.travelBreakFrac * size);
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

  /**
   * 把刚因停顿交出去的字收回来 —— 用户只是慢，并不是换字。
   * 返回 true 表示已经合并回 pending，调用方应把它当作"同一个字继续写"。
   */
  function restoreRecent(now, x, y) {
    if (!recentClose) return false;
    const { character, at } = recentClose;
    if (now - at > cfg.resumeGapMs) {
      recentClose = null;
      return false;
    }
    if (travel > travelLimit(character.bounds)) {
      recentClose = null;
      return false;
    }
    if (distanceToBounds(x, y, character.bounds) > resumeMargin(character.bounds)) {
      recentClose = null;
      return false;
    }
    pending.push(...character.strokes);
    recentClose = null;
    revoked += 1;
    // 引擎收到这个事件后要把已经交出去、可能已经识别过的那个字撤掉。
    emit('revoke', character);
    notify();
    return true;
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

      // 没在写的字里已经有笔迹：先判断这一笔是"同一个字的下一笔"还是"换字"。
      if (pending.length) {
        const pause = now - lastStrokeEnd;
        const bounds = pendingBounds();
        const margin = resumeMargin(bounds);
        const near = distanceToBounds(x, y, bounds) <= margin;
        const away = travel > travelLimit(bounds);
        const tooMany = pending.length >= cfg.maxStrokes;
        const tooBig = Math.max(bounds.width, bounds.height) > cfg.maxExtent;
        if (tooMany || tooBig) {
          closeCharacter('limit');
        } else if (pause > cfg.resumeGapMs || away) {
          // 手走开了或停太久：这是下一个字。
          closeCharacter('limit');
        } else if (pause > cfg.gapMs && !near) {
          // 停顿够长、而且这一笔离上一个字很远：也是下一个字。
          closeCharacter('gap');
        }
        // 其余情况（短停顿，或长停顿但落笔就在旁边）继续写同一个字。
      } else if (restoreRecent(now, x, y)) {
        // 刚交出去的字被接着写：已经收回来了，这一笔继续并进同一个字。
      }

      travel = 0;
      anchor = { x, y };
      live = {
        id: nextMarkId++,
        tool: style.tool === 'eraser' ? 'eraser' : 'pen',
        color: style.color || '#6ee7ff',
        width: style.width || 6,
        startedAt: now,
        points: [{ x, y, t: now }],
        /** 这一笔的近期速度（归一化单位/秒），跳变判定用。 */
        speed: 0,
      };
      notify();
      return live;
    },

    /**
     * 提笔期间每帧调用：累计"手走开了多远"。
     *
     * 分字需要的信号之一是"这一笔和上一笔是不是同一个字"。光看停顿时间会把
     * 慢慢写的多笔字拆开、又会把快速写的两个字并起来；而提笔后手有没有平移，
     * 是区分这两件事最可靠的线索。参考点用"提笔时笔尖的位置"，
     * 取最大位移而不是路径长度 —— 手抖来回晃不该算走开。
     */
    hover(x, y) {
      if (live) return travel;
      if (!anchor) anchor = { x, y };
      travel = Math.max(travel, Math.hypot(x - anchor.x, y - anchor.y));
      return travel;
    },

    /** Append a sample to the live stroke. Returns true when a point was kept. */
    move(x, y, now = performance.now()) {
      if (!live) return false;
      const points = live.points;
      const last = points[points.length - 1];
      const dist = Math.hypot(x - last.x, y - last.y);
      const dtMs = Math.max(1, now - last.t);
      const speed = dist / (dtMs / 1000);

      /*
       * 追踪跳变的第二道闸：按"隐含速度"判定。
       *
       * 原来只有 maxJumpDistance（单帧 0.25）这一道，0.05~0.24 的跳变会照抄进笔迹，
       * 在字上拉出一根尖刺；而真人快速写字时单帧位移也能到 0.1 以上，所以不能简单
       * 调小阈值。这里改成和这一笔自己的近期速度比：比均值快 4.5 倍以上的孤立点
       * 直接丢掉，正常的快写不会触发（速度均值本身就高）。
       */
      if (points.length >= 4 && dist >= cfg.glitchMinDistance && dtMs <= cfg.glitchMaxGapMs) {
        const limit = Math.max(cfg.glitchMinSpeed, (live.speed || 0) * cfg.glitchSpeedFactor);
        if (speed > limit) {
          dropped += 1;
          return false; // 丢样：下一个正常采样仍然从上一个有效点算起
        }
      }

      /*
       * 追踪跳变闸门（第一道，超大位移）：这一跳不是笔画，是 landmark 甩了。
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
      live.speed = live.speed ? live.speed * 0.7 + speed * 0.3 : speed;
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
      /*
       * "手走开多远"的参考点必须在提笔这一刻重新钉在笔尖上。
       * 否则 anchor 还是落笔点，抬笔后第一帧 hover 就把整笔的长度算成位移，
       * 一个 0.4 宽的字随手就被判成"手走开了"、被拆成不同的字。
       */
      const tip = stroke.points[stroke.points.length - 1];
      anchor = tip ? { x: tip.x, y: tip.y } : null;
      travel = 0;

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
