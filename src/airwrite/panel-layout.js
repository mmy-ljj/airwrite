/**
 * panel-layout.js — AirWrite 工具面板几何（纯函数，无 DOM）
 *
 * 契约：docs/AIRWRITE-CONTRACT.md §3（panel-layout.js 是纯几何、无 DOM，必须能在 Node 里
 * import 并直接断言）。引擎 src/airwrite/engine.js:17 消费本模块：
 *   import { hitTest, layoutPanel } from './panel-layout.js';
 *   engine.js:205 / engine.js:403-410  let panel = layoutPanel({ aspect });
 *   engine.js:434   hitTest(layout, state.cursor.x, state.cursor.y)   // ← 位置参数形式
 *
 * 坐标系约定（本文件唯一口径）
 *   - 全部数值归一化 0..1：x / w 相对画布宽，y / h 相对画布高。
 *   - 纵向"长度"换算：y 单位 = x 单位 * aspect   （aspect = 画布宽 / 画布高）
 *     因此下面所有几何常量都用"画布宽度"为单位书写；这样面板在像素上永远等比，
 *     aspect 变化时只是整体变高/变矮（这正是 layoutPanel 需要 aspect 的原因）。
 *   - 面板固定在画面底部居中，不跟随手掌（契约 §3：保证读数稳定）。
 *
 * 三行结构（契约 §3："工具 / 颜色 / 大小"三行）
 *   row 1 工具  kind='tool'  笔 / 橡皮擦 / 缩放        （列数 = cols，默认 3）
 *   row 2 颜色  kind='color' PALETTE 的 6 个色板       （固定 6 列）
 *   row 3 大小  kind='size'  随 tool 变化，见下一节
 *   （可选）`actions: true` 追加一行 kind='action'：撤销 / 清空 / 完成，默认关闭，
 *    因为契约 §3 的三行口径优先；engine.applyPanelSelection 已支持这三个 action。
 *
 * 尺寸行必须跟当前工具匹配（实测结论，务必读）
 *   engine.js:492-499 的 applyPanelSelection 按"当前工具"路由像素值：
 *     if (state.tool === 'eraser') state.eraserSize = value.size; else state.size = value.size;
 *   而 engine.js:434 的命中判定 `hitTest(layout, state.cursor.x, state.cursor.y)` 不带任何
 *   工具信息，layoutPanel 也无法自己知道工具。⇒ 如果面板同时画出笔档(6/10/16)与橡皮档
 *   (26/40)，笔模式悬停到橡皮格就会把画笔设成 40px（实测：tool=pen, size=40）。
 *   所以尺寸行按 tool 生成：
 *     tool='pen' | 'zoom' | 缺省 → PEN_SIZES 三档（6 / 10 / 16）
 *     tool='eraser'             → ERASER_SIZES 两档（26 / 40），条目仍带 eraserOnly: true
 *     tool='both'               → 两套都出（5 格，橡皮档带 eraserOnly），只给"渲染与命中
 *                                 都自己按工具过滤"的调用方；默认不用，因为 hitTest 过滤不了。
 *   消费方接入方式（engine.js:414-419 目前只按 aspect 缓存、且不传 tool）：
 *     const sig = `${aspect.toFixed(3)}|${state.tool}`;
 *     panel = layoutPanel({ aspect, tool: state.tool });
 *   eraserOnly 的约定（'both' 模式下）：true = 只在 state.tool === 'eraser' 时绘制，
 *   且几何上独占自己的格子、与笔档不重叠，避免 hitTest 歧义。
 *
 * 纯函数性：不读 DOM / window / localStorage / Date / 随机数；同一组入参永远返回
 * 深比较相等的几何（数值统一 round 到 1e-6）。
 */

import { PALETTE, PEN_SIZES, ERASER_SIZES, TOOL_LABELS } from './engine.js';

export const DEFAULT_ASPECT = 16 / 9;

/* ------------------------------------------------------------------ 常量 */

const PANEL_X = 0.08; // 面板左边缘（x 单位）；右边 = 0.08 + 0.84 = 0.92，居中
const PANEL_W = 0.84; // 面板宽（x 单位）
const PANEL_H = 0.17; // 面板高（x 单位）→ 16:9 时 = 0.17 * 1.7778 ≈ 0.302（y 单位）
const PANEL_BOTTOM = 0.88; // 面板底边（y 单位，从画布顶部往下量）
const PAD = 0.012; // 面板内边距（x 单位，四边等宽 → 像素上是正方形留白）
const GAP_X = 0.02; // 列间距（x 单位）
const GAP_Y = 0.01; // 行间距（x 单位）
const MIN_ROW_H = 0.006; // 行高下限（x 单位），极端入参下防止退化
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;
const COLS_MIN = 1;
const COLS_MAX = 6;

const SIZE_WORDS = ['细', '中', '粗', '特粗'];
const ERASER_WORDS = ['中', '粗', '特粗'];
const COLOR_WORDS = ['天蓝', '玫粉', '暖黄', '薄荷', '雪白', '暖橙'];

const TOOL_ORDER = ['pen', 'eraser', 'zoom'];

/* ------------------------------------------------------------- 工具函数 */

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function normalizeOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  let aspect = Number(o.aspect);
  if (!Number.isFinite(aspect) || aspect <= 0) aspect = DEFAULT_ASPECT;
  aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));

  let cols = Math.round(Number(o.cols));
  if (!Number.isFinite(cols) || cols <= 0) cols = 3;
  cols = Math.min(COLS_MAX, Math.max(COLS_MIN, cols));

  // 画布像素尺寸（可选）：只为竖屏（手机）分支服务，缺省 0 = 走旧算法
  const width = Number(o.width) > 0 ? Number(o.width) : 0;
  const height = Number(o.height) > 0 ? Number(o.height) : 0;

  return { aspect, cols, actions: !!o.actions, tool: normalizeTool(o.tool), width, height };
}

/** tool 归一化：'eraser' / 'both' 原样保留，其余（含 'zoom'、非法值）都当 'pen'。 */
function normalizeTool(tool) {
  if (tool === 'eraser') return 'eraser';
  if (tool === 'both') return 'both';
  return 'pen';
}

function toolLabel(tool) {
  const l = TOOL_LABELS && TOOL_LABELS[tool];
  if (l) return l;
  if (tool === 'pen') return '笔';
  if (tool === 'eraser') return '橡皮擦';
  if (tool === 'zoom') return '缩放';
  return tool;
}

/** 工具行：顺序固定为 pen / eraser / zoom（契约 §3b：第三项是缩放）。 */
function toolItems() {
  return TOOL_ORDER.map((tool) => ({
    id: `tool-${tool}`,
    kind: 'tool',
    label: toolLabel(tool),
    value: { tool },
  }));
}

/** 颜色行：PALETTE 的 6 个色板，顺序与 PALETTE 一致。 */
function colorItems() {
  const palette = Array.isArray(PALETTE) && PALETTE.length ? PALETTE : ['#6ee7ff'];
  return palette.map((color, i) => ({
    id: `color-${i + 1}`,
    kind: 'color',
    label: COLOR_WORDS[i] || color,
    value: { color },
  }));
}

/** 大小行：按 tool 决定出笔档还是橡皮档（见文件头"尺寸行必须跟当前工具匹配"）。 */
function sizeItems(tool) {
  const pens = Array.isArray(PEN_SIZES) && PEN_SIZES.length ? PEN_SIZES : [6, 10, 16];
  const erasers = Array.isArray(ERASER_SIZES) && ERASER_SIZES.length ? ERASER_SIZES : [26, 40];
  const out = [];
  if (tool !== 'eraser') {
    pens.forEach((size, i) => {
      out.push({
        id: `size-${size}`,
        kind: 'size',
        label: `${SIZE_WORDS[i] || ''} ${size}`.trim(),
        value: { size },
      });
    });
  }
  if (tool === 'eraser' || tool === 'both') {
    erasers.forEach((size, i) => {
      out.push({
        id: `size-eraser-${size}`,
        kind: 'size',
        label: `${ERASER_WORDS[i] || ''} ${size}`.trim(),
        value: { size },
        eraserOnly: true, // 'both' 模式下只在 state.tool === 'eraser' 时绘制
      });
    });
  }
  return out;
}

/** 可选第四行：撤销 / 清空 / 完成（engine.applyPanelSelection 支持 undo/clear/exit）。 */
function actionItems() {
  return [
    { id: 'action-undo', kind: 'action', label: '撤销', value: { action: 'undo' } },
    { id: 'action-clear', kind: 'action', label: '清空', value: { action: 'clear' } },
    { id: 'action-exit', kind: 'action', label: '完成', value: { action: 'exit' } },
  ];
}

/* ---------------------------------------------------------- layoutPanel */

/**
 * 生成工具面板几何。
 * @param {{ aspect?: number, cols?: number, actions?: boolean, tool?: string }} [opts]
 *   aspect 画布宽/高（默认 16/9；非法值或 <=0 时回退默认，并 clamp 到 [0.25, 4]）
 *   cols   "工具"行的列数（默认 3；工具条目多于 cols 时在工具区内换行）
 *   actions 是否追加"撤销/清空/完成"行（默认 false）
 *   tool   当前工具（'pen' | 'eraser' | 'zoom' | 'both'）：决定尺寸行出哪套像素档位，
 *          见文件头"尺寸行必须跟当前工具匹配"。缺省 / 'zoom' → 笔档。
 * @returns {{ x: number, y: number, w: number, h: number, aspect: number,
 *             cols: number, rows: number, tool: string,
 *             items: Array<{ id: string, kind: string, label: string,
 *                            value: object, x: number, y: number, w: number, h: number,
 *                            row: number, eraserOnly?: boolean }> }}
 *   x/y/w/h 归一化 0..1（x/w 相对宽，y/h 相对高），且 x+w <= 1、y+h <= 1。
 */
export function layoutPanel(opts) {
  const { aspect, cols, actions, tool, width, height } = normalizeOptions(opts);

  // 三行（+ 可选 action 行）。每行声明自己的网格列数。
  const tools = toolItems();
  const colors = colorItems();
  const sizes = sizeItems(tool);
  const groups = [
    { items: tools, columns: cols },
    { items: colors, columns: Math.max(1, colors.length) },
    { items: sizes, columns: Math.max(1, sizes.length) },
  ];
  if (actions) groups.push({ items: actionItems(), columns: cols });

  // 视觉行数（每个 group 可能因为 columns 限制而占用多个子行）
  let rows = 0;
  for (const g of groups) rows += Math.max(1, Math.ceil(g.items.length / g.columns));
  if (rows < 1) rows = 1;

  /* 几何：横屏沿用「以宽度为基准」的旧算法；竖屏（手机）改成按像素给行高。
     手机竖屏 390x844 时 aspect=0.46，旧算法把面板高算成 0.17*390 ≈ 66px，
     每行只有 16px —— 手指根本点不中（回归见 tools/test_engine.mjs 第 9 节）。 */
  let x;
  let y;
  let w;
  let h;
  let innerX;
  let innerW;
  let gapX;
  let rowH_y;
  let gapY_y;
  let padY_y;

  const portraitPx = width > 0 && height > 0 && aspect < 0.95;
  /* 画布底部压着工具栏与提示行（DOM）：面板底边必须留在它们上面，否则窄屏/横屏
     手机上"笔迹 0 · 字 0"会盖住面板最下面一行（844x390 实测会重叠）。按像素预留。 */
  const bottomReservePx = portraitPx ? 84 : 64;
  if (portraitPx) {
    const marginX = 12;
    const marginBottom = bottomReservePx;
    const padPx = 9;
    const gapPx = 8;
    const maxPanelPx = height * 0.66;
    let rowHpx = 54; // 一行 54px：手指悬停/点选都点得中
    if (2 * padPx + rows * rowHpx + (rows - 1) * gapPx > maxPanelPx) {
      rowHpx = Math.max(38, (maxPanelPx - 2 * padPx - (rows - 1) * gapPx) / rows);
    }
    const panelWPx = Math.min(width - 2 * marginX, 560);
    const panelHPx = 2 * padPx + rows * rowHpx + (rows - 1) * gapPx;
    const panelXPx = (width - panelWPx) / 2;
    const panelYPx = Math.max(0, height - marginBottom - panelHPx);

    x = round6(panelXPx / width);
    y = round6(panelYPx / height);
    w = round6(panelWPx / width);
    h = round6(panelHPx / height);
    gapX = gapPx / width;
    innerX = x + padPx / width;
    innerW = w - 2 * (padPx / width);
    rowH_y = rowHpx / height;
    gapY_y = gapPx / height;
    padY_y = padPx / height;
  } else {
    // 纵向：先按目标面板高推行高，再反推真实面板高（保证内部自洽）
    const targetInnerH = PANEL_H - 2 * PAD;
    const rawRowH = (targetInnerH - (rows - 1) * GAP_Y) / rows;
    const rowH = Math.max(MIN_ROW_H, rawRowH);
    const panelH = 2 * PAD + rows * rowH + (rows - 1) * GAP_Y; // x 单位
    const panelH_y = panelH * aspect;

    x = round6(PANEL_X);
    y = round6(PANEL_BOTTOM - panelH_y);
    w = round6(PANEL_W);
    h = round6(panelH_y);
    gapX = GAP_X;
    innerX = PANEL_X + PAD;
    innerW = PANEL_W - 2 * PAD;
    rowH_y = rowH * aspect;
    gapY_y = GAP_Y * aspect;
    padY_y = PAD * aspect;
  }

  // 统一把面板抬到底部预留区之上（横屏手机这类"矮"视口靠这一条救回来）
  if (width > 0 && height > 0) {
    const maxBottomNorm = Math.max(0, (height - bottomReservePx) / height);
    if (y + h > maxBottomNorm) y = round6(Math.max(0, maxBottomNorm - h));
  }

  const items = [];
  let rowIndex = 0;

  for (const g of groups) {
    const columns = Math.max(1, g.columns);
    const n = g.items.length;
    const subRows = Math.max(1, Math.ceil(n / columns));
    const cellW = (innerW - (columns - 1) * gapX) / columns;

    for (let r = 0; r < subRows; r++) {
      const slice = g.items.slice(r * columns, r * columns + columns);
      const count = slice.length;
      if (count === 0) continue;
      const groupW = count * cellW + (count - 1) * gapX;
      const startX = innerX + (innerW - groupW) / 2; // 条目组在本行内居中
      const itemY = y + padY_y + rowIndex * (rowH_y + gapY_y);

      slice.forEach((def, i) => {
        const ix = round6(startX + i * (cellW + gapX));
        const iw = round6(cellW);
        const iy = round6(itemY);
        const ih = round6(rowH_y);
        items.push({
          id: def.id,
          kind: def.kind,
          label: def.label,
          value: def.value,
          // 夹紧，保证归一化不越界（浮点/取整后仍满足 x+w<=1、y+h<=1）
          x: Math.max(0, Math.min(ix, 1)),
          y: Math.max(0, Math.min(iy, 1)),
          w: Math.max(0, Math.min(iw, 1 - Math.max(0, Math.min(ix, 1)))),
          h: Math.max(0, Math.min(ih, 1 - Math.max(0, Math.min(iy, 1)))),
          row: rowIndex,
          ...(def.eraserOnly ? { eraserOnly: true } : {}),
        });
      });
      rowIndex++;
    }
  }

  return { x, y, w, h, aspect: round6(aspect), cols, rows, tool, items };
}

/* ------------------------------------------------------------- hitTest */

/** 归一化 pad 解析：支持数字、{pad}、{padPx, pixelScale} 三种写法。 */
function resolvePad(padArg) {
  let padX = 0;
  let padY = 0;
  if (typeof padArg === 'number' && Number.isFinite(padArg)) {
    padX = padY = padArg;
  } else if (padArg && typeof padArg === 'object') {
    const plain = Number(padArg.pad);
    if (Number.isFinite(plain)) padX = padY = plain;
    const px = Number(padArg.padPx);
    const scale = Number(padArg.pixelScale);
    if (Number.isFinite(px) && Number.isFinite(scale) && scale > 0) {
      // 8px 容差：pad = padPx / 画布宽度(px)
      padX = padY = px / scale;
    }
    const dpX = Number(padArg.padX);
    const dpY = Number(padArg.padY);
    if (Number.isFinite(dpX)) padX = dpX;
    if (Number.isFinite(dpY)) padY = dpY;
  }
  return { padX: Math.max(0, padX), padY: Math.max(0, padY) };
}

/**
 * 命中测试。三种调用形式都支持（契约/引擎用①，光标对象用②）：
 *   ① hitTest(layout, nx, ny)           // engine.js:434 实际调用形式
 *   ② hitTest(layout, { x: nx, y: ny })
 *   ③ hitTest(layout, nx, ny, pad)      // pad 也可传 { pad } / { padPx, pixelScale }
 * pad 是归一化外扩容差，默认 0（例如 8px 容差 = hitTest(layout, nx, ny,
 * { padPx: 8, pixelScale: canvasWidthPx })）。
 * @returns 命中的 item（layout 里的原对象，便于调用方扩展），未命中返回 null。
 *          多个条目重叠时返回 items 中靠前的那个（本布局同行条目互不重叠）。
 */
export function hitTest(layout, a, b, c) {
  let point;
  let padArg;
  if (a && typeof a === 'object') {
    point = { x: Number(a.x), y: Number(a.y) };
    padArg = b;
  } else {
    point = { x: Number(a), y: Number(b) };
    padArg = c;
  }
  if (!layout || !Array.isArray(layout.items)) return null;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

  const { padX, padY } = resolvePad(padArg);
  for (const item of layout.items) {
    if (!item) continue;
    const ix = Number(item.x);
    const iy = Number(item.y);
    const iw = Number(item.w);
    const ih = Number(item.h);
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) continue;
    if (!Number.isFinite(iw) || !Number.isFinite(ih)) continue;
    if (
      point.x >= ix - padX &&
      point.x <= ix + iw + padX &&
      point.y >= iy - padY &&
      point.y <= iy + ih + padY
    ) {
      return item;
    }
  }
  return null;
}
