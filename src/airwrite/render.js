/**
 * AirWrite 渲染层：把引擎的状态画到 canvas 上。
 *
 * 图层分工：
 *   * inkCanvas —— 已经写完的笔迹，只在内容/缩放/平移变化时重绘（缓存上千点也不掉帧）
 *   * canvas    —— 每帧重绘的"活物"：正在写的笔、雪花粒子、光标、手掌面板
 *
 * 坐标约定：引擎里的一切都是**归一化视频坐标**，渲染时统一走 ViewMapper，
 * 所以"手指指到哪、笔就画到哪"，缩放平移之后依然对齐。
 * 线宽统一用 CSS 像素，乘 devicePixelRatio 得到物理像素。
 */

import { ViewMapper } from '../render/mapper.js';
import { glow, neonLine, roundRect, withAlpha } from '../render/draw.js';
import { drawEraserCursor, drawEraserModel } from './eraser-model.js';

/** 画布上的面板配色（与 styles.css 的霓虹暗色系一致）。 */
const PANEL = {
  bg: 'rgba(8, 12, 24, 0.82)',
  border: 'rgba(126, 231, 255, 0.35)',
  item: 'rgba(18, 26, 46, 0.9)',
  itemHot: 'rgba(110, 231, 255, 0.24)',
  text: '#dcefff',
  dim: '#7f93b0',
  accent: '#6ee7ff',
};

/* 雪花精灵图（m02869）。
 *
 * 以前每片雪花是"两根粗线"——几千个粒子逐帧描边，只能画成一团，看起来
 * 像白色噪点而不是雪。现在把四种雪花形状预渲染成小画布，每帧只做一次
 * drawImage：形状（六臂/八臂/细枝/冰渣）和旋转缩放都不再受性能限制。
 * 精灵图按 variant + 颜色缓存，颜色只有调色板那几种，缓存不会涨。 */
const FLAKE_SPRITES = new Map();
const FLAKE_SIZE = 72;

function drawFlakePath(g, r, color, variant) {
  const arms = variant === 2 ? 8 : variant === 3 ? 4 : 6;
  const branches = variant === 1 ? 3 : variant === 3 ? 1 : 2;
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < arms; i += 1) {
    g.save();
    g.rotate((i / arms) * Math.PI * 2 + variant * 0.19);
    g.lineWidth = Math.max(1, r * (variant === 3 ? 0.22 : variant === 2 ? 0.1 : 0.14));
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -r);
    g.stroke();
    for (let b = 1; b <= branches; b += 1) {
      const at = 0.42 + b * (0.5 / (branches + 1));
      const len = r * (0.36 - b * 0.06);
      g.lineWidth = Math.max(0.8, r * (variant === 3 ? 0.12 : 0.075));
      g.beginPath();
      g.moveTo(0, -r * at);
      g.lineTo(len, -r * at - len * 0.8);
      g.moveTo(0, -r * at);
      g.lineTo(-len, -r * at - len * 0.8);
      g.stroke();
    }
    g.restore();
  }
  // 中心一点高光/冰晶核心，让雪花在暗底上"亮"起来
  const core = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.55);
  core.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  core.addColorStop(0.45, withAlpha(color, 0.6));
  core.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = core;
  g.beginPath();
  g.arc(0, 0, r * 0.55, 0, Math.PI * 2);
  g.fill();
}

/** variant 0-3，颜色任意；Node/无 DOM 环境返回 null（调用方退回不画）。 */
function flakeSprite(variant, color) {
  if (typeof document === 'undefined') return null;
  const key = `${variant}|${color}`;
  const cached = FLAKE_SPRITES.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = FLAKE_SIZE;
  canvas.height = FLAKE_SIZE;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.translate(FLAKE_SIZE / 2, FLAKE_SIZE / 2);
  drawFlakePath(g, FLAKE_SIZE * 0.42, color, variant);
  FLAKE_SPRITES.set(key, canvas);
  return canvas;
}

export function createAirWriteRenderer({
  canvas,
  inkCanvas = null,
  mapper = new ViewMapper(),
  engine,
  dpr = () => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
  /**
   * 画布后备缓冲的 DPR 上限。手机经常是 3x：430×932 的逻辑尺寸会变成
   * 1290×2796 × 2 层画布，每帧全量重绘直接拖垮 GPU，而 3x 和 2x 的笔迹
   * 肉眼看不出差别 —— 所以默认压到 2。
   */
  maxDpr = 2,
} = {}) {
  const ctx = canvas.getContext('2d');
  const inkCtx = inkCanvas ? inkCanvas.getContext('2d') : ctx;

  let width = 0;
  let height = 0;
  let ratio = dpr();
  let lastViewport = { width: 0, height: 0, videoWidth: 0, videoHeight: 0 };
  let zoomKey = '';
  let inkKey = '';
  let panelRects = [];

  /** 画布尺寸 / DPR 变了就重建 backing store（并同步 CSS 尺寸）。 */
  function resize(view = {}) {
    const cssWidth = view.width || canvas.clientWidth || canvas.width;
    const cssHeight = view.height || canvas.clientHeight || canvas.height;
    ratio = Math.min(dpr(), maxDpr || 2);
    width = cssWidth;
    height = cssHeight;
    for (const [surface, context] of [
      [canvas, ctx],
      [inkCanvas, inkCtx],
    ]) {
      if (!surface) continue;
      surface.width = Math.max(1, Math.round(cssWidth * ratio));
      surface.height = Math.max(1, Math.round(cssHeight * ratio));
      if (surface !== canvas) {
        surface.style.width = `${cssWidth}px`;
        surface.style.height = `${cssHeight}px`;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    return { width, height, ratio };
  }

  /** 每帧同步视口 + 缩放/平移到 mapper，并把换算结果告诉引擎。 */
  function syncViewport(view = {}) {
    const videoWidth = view.videoWidth || lastViewport.videoWidth || 1280;
    const videoHeight = view.videoHeight || lastViewport.videoHeight || 720;
    if (
      lastViewport.width !== width ||
      lastViewport.height !== height ||
      lastViewport.videoWidth !== videoWidth ||
      lastViewport.videoHeight !== videoHeight
    ) {
      lastViewport = { width, height, videoWidth, videoHeight };
      mapper.setViewport(width, height, videoWidth, videoHeight);
      inkKey = '';
    }

    const zoom = engine?.zoom || { level: 1, panX: 0, panY: 0 };
    const key = `${round4(zoom.level)}|${round4(zoom.panX)}|${round4(zoom.panY)}`;
    if (key !== zoomKey) {
      zoomKey = key;
      mapper.setZoom(zoom.level || 1);
      if (typeof mapper.setPan === 'function') {
        // 引擎的 pan 是"归一化视频"比例（等于手掌位移），换算成画布像素交给 mapper。
        const scale = mapper.pixelScale || 1;
        mapper.setPan((zoom.panX || 0) * scale, (zoom.panY || 0) * scale);
      }
      inkKey = '';
    }

    if (engine?.setViewport) {
      engine.setViewport({
        pixelScale: mapper.pixelScale,
        aspect: width / Math.max(1, height),
        // 面板画在画布坐标系里，而光标是视频坐标系：把投影函数交给引擎，
        // 命中测试才能落在"眼睛看到的那一格"上（cover 裁剪下两者不等价）。
        project: (point) => mapper.point(point),
        canvasWidth: width,
        canvasHeight: height,
      });
    }
    return mapper;
  }

  const round4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0);

  /* ------------------------------------------------------------ 笔迹 */

  /** 一笔画成：点用归一化坐标，宽度用 CSS 像素。 */
  function drawStroke(context, points, color, widthCss, alpha = 1, endpoints = false) {
    if (!points || !points.length) return;
    const lineWidth = Math.max(1, (widthCss || 6) * ratio);
    const soft = Math.max(2, lineWidth * 2.2);
    if (points.length === 1) {
      const only = mapper.point(points[0]);
      glow(context, only.x, only.y, soft, color, alpha);
      return;
    }
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    const first = mapper.point(points[0]);
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i += 1) {
      const next = mapper.point(points[i]);
      context.lineTo(next.x, next.y);
    }
    context.stroke();
    context.restore();
    if (endpoints) {
      const last = mapper.point(points[points.length - 1]);
      glow(context, first.x, first.y, soft, color, 0.3 * alpha);
      glow(context, last.x, last.y, soft, color, 0.3 * alpha);
    }
  }

  /** 在主 canvas 上叠一层霓虹拖影（仅"活笔"需要，静态笔迹靠图层缓存）。 */
  function drawStrokeNeon(context, points, color, widthCss, alpha = 1) {
    if (!points || points.length < 2) return;
    let prev = mapper.point(points[0]);
    for (let i = 1; i < points.length; i += 1) {
      const next = mapper.point(points[i]);
      neonLine(context, prev.x, prev.y, next.x, next.y, Math.max(1, (widthCss || 6) * ratio), color, alpha);
      prev = next;
    }
  }

  /** 静态笔迹画到 inkCanvas；只有内容/缩放变化时才重画。 */
  function drawInkLayer() {
    if (!inkCanvas) return;
    const marks = engine?.strokes || [];
    const version = engine?.strokesVersion ?? 0;
    const key = `${version}|${marks.length}|${zoomKey}`;
    if (key === inkKey) return;
    inkKey = key;
    inkCtx.save();
    inkCtx.setTransform(1, 0, 0, 1, 0, 0);
    inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    inkCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    inkCtx.globalCompositeOperation = 'lighter';
    for (const mark of marks) drawStroke(inkCtx, mark.points, mark.color, mark.width, 0.95, false);
    inkCtx.restore();
  }

  /* ------------------------------------------------------------ 雪花（m00477） */

  function drawSnow(context, particles) {
    if (!particles || !particles.length) return;
    // 分两遍画：先把远处的碎屑铺上去，再叠近处的大片雪花，
    // 散开时才有前后景，而不是一层同样大的点。
    for (let pass = 0; pass < 2; pass += 1) {
      for (const p of particles) {
        const depth = p.depth ?? 0.5;
        if (pass === 0 ? depth >= 0.5 : depth < 0.5) continue;
        const alpha = engine.snowAlpha ? engine.snowAlpha(p) : 1;
        if (alpha <= 0.01) continue;
        const screen = mapper.point(p);
        const size = Math.min(
          44 * ratio,
          Math.max(2, (p.size || 4) * ratio * (0.85 + depth * 0.85)),
        );
        const sprite = flakeSprite(p.variant ?? 0, p.color || '#ffffff');
        if (!sprite) continue;
        context.save();
        context.translate(screen.x, screen.y);
        context.rotate(p.rot || 0);
        context.globalAlpha = alpha * (0.55 + depth * 0.45);
        context.drawImage(sprite, -size / 2, -size / 2, size, size);
        context.restore();
        // 只给近处的一小部分加光晕：逐粒子建径向渐变太贵，几千片不能都来
        if (depth > 0.82 && (p.variant ?? 0) === 0) {
          glow(context, screen.x, screen.y, size * 1.9, p.color, alpha * 0.3);
        }
      }
    }
  }

  /* ------------------------------------------------------------ 光标（m00228） */

  function drawCursor(context, now) {
    const state = engine.state;
    const cursor = state.cursor;
    if (!cursor.active) return;
    const screen = mapper.point(cursor);
    const eraser = state.tool === 'eraser';
    const base = (eraser ? 22 : 12) * ratio;
    const color = eraser ? '#ff8a5c' : state.color || PANEL.accent;
    const pinched = cursor.pinch <= (engine.config?.pinchStart ?? 0.42);
    glow(context, screen.x, screen.y, base * 1.7, color, eraser ? 0.28 : 0.5);
    context.save();
    if (eraser) {
      // 橡皮擦用 2D 模型当光标（src/airwrite/eraser-model.js），
      // 虚线圆=实际擦除半径，橡皮的擦除端贴在指尖上。
      const radius = Math.max(10, state.eraserSize || 26) * ratio;
      drawEraserCursor(context, {
        x: screen.x,
        y: screen.y,
        size: Math.min(104 * ratio, Math.max(30 * ratio, radius * 2.2)),
        radius: radius * 0.96,
        press: pinched ? 1 : 0,
        ratio,
      });
    } else {
      context.strokeStyle = color;
      context.lineWidth = 2 * ratio;
      context.beginPath();
      context.arc(screen.x, screen.y, pinched ? base * 0.55 : base, 0, Math.PI * 2);
      context.stroke();
    }
    const hit = engine.selection?.hit;
    if (hit) {
      const p = Math.max(0, Math.min(1, hit.progress || 0));
      context.strokeStyle = PANEL.accent;
      context.lineWidth = 3.5 * ratio;
      context.beginPath();
      context.arc(screen.x, screen.y, base + 9 * ratio, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      context.stroke();
    }
    context.restore();
    void now;
  }

  /* ------------------------------------------------------------ 手掌面板（m00209 / m00304） */

  function drawPanel(context, now) {
    const layout = engine.toolLayout;
    const state = engine.state;
    const selection = engine.selection;
    if (!layout || !layout.items) return [];
    const css = ratio;
    const rects = [];
    const px = (n, axis) => (axis === 'x' ? n * width : n * height);
    const panelRect = {
      x: px(layout.x, 'x'),
      y: px(layout.y, 'y'),
      w: px(layout.w, 'x'),
      h: px(layout.h, 'y'),
    };
    const radius = Math.min(16 * css, panelRect.h / 3);
    context.save();
    context.globalAlpha = 0.97;
    roundRect(context, panelRect.x, panelRect.y, panelRect.w, panelRect.h, radius);
    context.fillStyle = PANEL.bg;
    context.fill();
    context.strokeStyle = PANEL.border;
    context.lineWidth = 1.5 * css;
    context.stroke();

    for (const item of layout.items) {
      const rect = {
        x: panelRect.x + px(item.x - layout.x, 'x'),
        y: panelRect.y + px(item.y - layout.y, 'y'),
        w: px(item.w, 'x'),
        h: px(item.h, 'y'),
      };
      const active = isItemActive(item, state);
      const hot = !!selection?.hit && selection.hit.id === item.id;
      roundRect(context, rect.x, rect.y, rect.w, rect.h, Math.min(10 * css, rect.h / 2));
      context.fillStyle = active ? withAlpha(PANEL.accent, 0.3) : hot ? PANEL.itemHot : PANEL.item;
      context.fill();
      context.strokeStyle = active ? PANEL.accent : hot ? withAlpha(PANEL.accent, 0.7) : 'rgba(120,150,190,0.35)';
      context.lineWidth = (active || hot ? 2 : 1) * css;
      context.stroke();
      if (hot && selection.hit.progress) {
        context.save();
        roundRect(context, rect.x, rect.y, rect.w * selection.hit.progress, rect.h, Math.min(10 * css, rect.h / 2));
        context.fillStyle = withAlpha(PANEL.accent, 0.3);
        context.fill();
        context.restore();
      }

      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      if (item.kind === 'color') {
        context.beginPath();
        context.arc(cx, cy, Math.min(rect.w, rect.h) * 0.3, 0, Math.PI * 2);
        context.fillStyle = item.value?.color || '#ffffff';
        context.fill();
        context.strokeStyle = 'rgba(255,255,255,0.75)';
        context.lineWidth = 1.5 * css;
        context.stroke();
      } else if (item.kind === 'size') {
        // 笔尖/橡皮的直径预览：按格子高度夹一下，40px 的橡皮也不会撑破格子
        const r = Math.max(2 * css, Math.min(rect.h * css * 0.34, ((item.value?.size || 6) / 2) * 1.4 * css));
        context.beginPath();
        context.arc(cx, cy, r, 0, Math.PI * 2);
        context.fillStyle = active ? '#081020' : PANEL.text;
        context.fill();
      } else if (item.value?.tool === 'eraser') {
        // 工具格里的橡皮擦：画同一块 2D 橡皮；格子够高就在下面补一行小字
        const cellH = rect.h / css;
        const withLabel = cellH >= 44;
        const iconSize = Math.min(rect.w * 0.5, (withLabel ? cellH * 0.34 : cellH * 0.62)) * css;
        drawEraserModel(context, {
          x: cx - iconSize * 0.3,
          y: cy - (withLabel ? cellH * css * 0.22 : 0),
          size: iconSize,
          angle: -0.38,
          alpha: 1,
        });
        if (withLabel) {
          context.fillStyle = active ? '#081020' : PANEL.text;
          context.font = `600 ${Math.max(11, Math.min(14, cellH * 0.3)) * css}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(item.label || item.id, cx, cy + cellH * css * 0.34);
        }
      } else {
        context.fillStyle = active ? '#081020' : PANEL.text;
        context.font = `600 ${Math.max(11, Math.min(16, rect.h * 0.4)) * css}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(item.label || item.id, cx, cy);
      }
      rects.push({ ...item, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    }

    context.fillStyle = PANEL.dim;
    context.font = `500 ${13 * css}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.fillText('食指指向选择 · 再次张开手掌退出', panelRect.x + panelRect.w / 2, panelRect.y - 10 * css);
    context.restore();
    panelRects = rects;
    void now;
    return rects;
  }

  function isItemActive(item, state) {
    const value = item.value || {};
    if (value.tool) return state.tool === value.tool;
    if (value.color) return (state.color || '').toLowerCase() === value.color.toLowerCase();
    if (value.size !== undefined) {
      return state.tool === 'eraser' ? state.eraserSize === value.size : state.size === value.size;
    }
    return false;
  }

  /* ------------------------------------------------------------ 主绘制 */

  function draw({ video = null, now = 0 } = {}) {
    syncViewport({
      videoWidth: video?.videoWidth,
      videoHeight: video?.videoHeight,
    });
    drawInkLayer();

    // 只有一张 canvas 时，静态笔迹得由本层重画；否则只清 overlay。
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.restore();
    if (!inkCanvas) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const mark of engine.strokes || []) drawStroke(ctx, mark.points, mark.color, mark.width, 0.95, false);
      ctx.restore();
    }

    // 正在写的笔：本体 + 霓虹拖影
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const live = engine.liveStroke;
    if (live && live.points.length) {
      drawStroke(ctx, live.points, live.color, live.width, 0.95, true);
      drawStrokeNeon(ctx, live.points, live.color, live.width, 0.4);
    }
    ctx.restore();

    ctx.save();
    drawSnow(ctx, engine.snowParticles);
    ctx.restore();

    ctx.save();
    drawCursor(ctx, now);
    ctx.restore();

    const rects = engine.state.selectionMode ? drawPanel(ctx, now) : [];

    return { rects, mapper, width, height, ratio };
  }

  /** 画布像素 -> 归一化坐标（鼠标点击面板 / 无摄像头时写字）。 */
  function toNormalized(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / Math.max(1, rect.width),
      y: (clientY - rect.top) / Math.max(1, rect.height),
    };
  }

  return {
    mapper,
    resize,
    syncViewport,
    draw,
    drawStroke,
    toNormalized,
    get panelRects() {
      return panelRects;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get ratio() {
      return ratio;
    },
    invalidateInk() {
      inkKey = '';
    },
  };
}
