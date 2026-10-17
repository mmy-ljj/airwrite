/**
 * panel-ui.js — AirWrite 工具面板的 DOM 层（契约 docs/AIRWRITE-CONTRACT.md §3）
 *
 *   createPanelUI(host, api) -> { setState, setLayout, destroy, element }
 *
 * 设计边界（很重要）：本模块**只产出结构与状态，不产出外观**。
 *   - 外观（颜色/间距/圆角/动效/全屏按钮）统一由 Lead 的 index.html + styles.css 负责，
 *     所以这里不加任何内联视觉样式，只加 class + data-* + CSS 变量（见下）。
 *   - 面板几何来自 panel-layout.js：`setState({ layout })` 时按 layout.items 生成/复用按钮，
 *     并把每个条目的归一化矩形写成 CSS 变量，供 styles.css 选择使用。
 *   - 点击只调 `api.select({ id, kind, label, value })`，**不直接改引擎**（契约 §3）。
 *     "完成"按钮调 `api.exit()`。
 *
 * 结构（全部带 data-tool-id）：
 *   host.air-panel[data-active][data-tool]
 *     .air-panel__row[data-row="tools"|"colors"|"sizes"|"actions"]
 *       button.air-panel__item[data-tool-id][data-kind][data-active][data-hot]
 *                           [data-eraser-only][aria-pressed][aria-label]
 *         span.air-panel__swatch              (kind='color'，内联 --swatch = 颜色值)
 *         span.air-panel__label               (文字标签，中文)
 *     .air-panel__row[data-row="footer"] > button.air-panel__done[data-tool-id="action-exit"]
 *
 * 每个条目元素上可用的 CSS 变量：
 *   --item-x / --item-y / --item-w / --item-h  ：归一化几何（0..1，相对画布）
 *   --dwell-progress                           ：0..1 悬停进度（命中时才有；Lead 用它画进度环）
 *   --swatch                                   ：颜色值（仅 kind='color'）
 * styles.css 示例：`.air-panel__item[data-active="true"] { outline: 2px solid #6ee7ff }`
 *
 * eraserOnly 约定：layout 里带 `eraserOnly: true` 的条目（橡皮宽度档）约定"只在
 * state.tool === 'eraser' 时绘制"。本模块只写 `data-eraser-only="true"`，由 styles.css 决定：
 *   `.air-panel[data-tool="pen"] .air-panel__item[data-eraser-only] { display: none }`
 * 键盘可达：条目是原生 <button>（Enter/Space 直接触发 click），并支持方向键在条目间移动焦点。
 *
 * 无 DOM 依赖的模块级代码：本文件在 import 时不触碰 document/window，可在 Node 里直接 import。
 */

import { layoutPanel } from './panel-layout.js';

const ROW_ORDER = ['tools', 'colors', 'sizes', 'actions'];

function setVars(el, item) {
  const s = el.style;
  if (!s || typeof s.setProperty !== 'function') return;
  s.setProperty('--item-x', String(item.x));
  s.setProperty('--item-y', String(item.y));
  s.setProperty('--item-w', String(item.w));
  s.setProperty('--item-h', String(item.h));
}

function rowKeyFor(item) {
  if (item.kind === 'tool') return 'tools';
  if (item.kind === 'color') return 'colors';
  if (item.kind === 'size') return 'sizes';
  if (item.kind === 'action') return 'actions';
  return 'tools';
}

/** 与 render.js 的 isItemActive 同口径的"当前是否选中"。 */
function isItemActive(item, state) {
  const value = item.value || {};
  if (value.tool) return state.tool === value.tool;
  if (value.color) return String(state.color || '').toLowerCase() === String(value.color).toLowerCase();
  if (value.size !== undefined) {
    // 尺寸档位要跟当前工具走：engine.js:492-499 按 tool 决定写 size 还是 eraserSize
    const cur = state.tool === 'eraser' && state.eraserSize !== undefined ? state.eraserSize : state.size;
    return Number(cur) === Number(value.size);
  }
  return false;
}

/**
 * @param {HTMLElement} host  index.html 里的 `<div id="air-panel" class="air-panel" hidden>`
 * @param {{ select?: Function, exit?: Function, palette?: string[], tools?: any[] }} [api]
 * @returns {{ setState: Function, setLayout: Function, destroy: Function, element: HTMLElement,
 *             items: () => Array, rows: () => Array }}
 */
export function createPanelUI(host, api = {}) {
  if (!host || typeof host.appendChild !== 'function') {
    throw new Error('createPanelUI: 需要一个 DOM host（<div id="air-panel">）');
  }
  const doc = (host.ownerDocument || (typeof document !== 'undefined' ? document : null));
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('createPanelUI: 找不到 document，本模块需要浏览器环境');
  }

  const callbacks = api && typeof api === 'object' ? api : {};
  const select = typeof callbacks.select === 'function' ? callbacks.select : () => {};
  const exit = typeof callbacks.exit === 'function' ? callbacks.exit : () => {};

  let layout = null;
  let signature = '';
  let rowEls = new Map(); // rowKey -> element
  let itemEls = new Map(); // item.id -> { item, el, row, labelEl }
  let allEls = []; // 便于 destroy / 方向键导航

  const activeLayout = () => (layout && Array.isArray(layout.items) ? layout : layoutPanel());

  function layoutSignature(l) {
    return l.items.map((i) => i.id).join('|') + '#' + l.items.length;
  }

  /** 按 layout 重建按钮（id 集合变化时才重建）。 */
  function build(nextLayout) {
    if (nextLayout && Array.isArray(nextLayout.items) && nextLayout.items.length) layout = nextLayout;
    const l = activeLayout();
    const sig = layoutSignature(l);
    if (sig === signature && itemEls.size) {
      // 几何可能变了：刷新变量
      for (const { item, el } of itemEls.values()) {
        const fresh = l.items.find((i) => i.id === item.id);
        if (fresh) setVars(el, fresh);
      }
      return;
    }
    clear();
    signature = sig;
    host.classList && host.classList.add('air-panel');

    const byRow = new Map();
    for (const item of l.items) {
      const key = rowKeyFor(item);
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(item);
    }

    const order = ROW_ORDER.filter((k) => byRow.has(k));
    for (const key of byRow.keys()) if (!order.includes(key)) order.push(key);

    for (const key of order) {
      const row = doc.createElement('div');
      row.className = 'air-panel__row';
      row.setAttribute('data-row', key);
      row.setAttribute('role', 'group');
      for (const item of byRow.get(key)) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'air-panel__item';
        btn.setAttribute('data-tool-id', item.id);
        btn.setAttribute('data-kind', item.kind);
        btn.setAttribute('data-active', 'false');
        btn.setAttribute('data-hot', 'false');
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', item.label || item.id);
        btn.title = item.label || item.id;
        if (item.eraserOnly) btn.setAttribute('data-eraser-only', 'true');
        setVars(btn, item);

        let labelEl = null;
        if (item.kind === 'color') {
          const sw = doc.createElement('span');
          sw.className = 'air-panel__swatch';
          sw.setAttribute('aria-hidden', 'true');
          if (sw.style && typeof sw.style.setProperty === 'function') {
            sw.style.setProperty('--swatch', String(item.value && item.value.color ? item.value.color : '#ffffff'));
          }
          btn.appendChild(sw);
        }
        labelEl = doc.createElement('span');
        labelEl.className = 'air-panel__label';
        labelEl.textContent = item.label || item.id;
        btn.appendChild(labelEl);

        btn.addEventListener('click', () => {
          select({ id: item.id, kind: item.kind, label: item.label, value: item.value });
        });
        btn.addEventListener('keydown', (event) => onItemKeydown(event, item.id, key));
        row.appendChild(btn);
        itemEls.set(item.id, { item, el: btn, row: key });
        allEls.push(btn);
      }
      host.appendChild(row);
      rowEls.set(key, row);
    }

    // 契约 §3 要求一个"完成"按钮；action 行里已有 action-exit 就不重复
    if (!itemEls.has('action-exit')) {
      const footer = doc.createElement('div');
      footer.className = 'air-panel__row';
      footer.setAttribute('data-row', 'footer');
      const done = doc.createElement('button');
      done.type = 'button';
      done.className = 'air-panel__done';
      done.setAttribute('data-tool-id', 'action-exit');
      done.setAttribute('data-kind', 'action');
      done.textContent = '完成';
      done.addEventListener('click', () => exit());
      footer.appendChild(done);
      host.appendChild(footer);
      rowEls.set('footer', footer);
      allEls.push(done);
    }
  }

  /** 方向键在条目间移动焦点（Enter/Space 由原生 button 处理）。 */
  function onItemKeydown(event, id, key) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!event || !keys.includes(event.key)) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const rowIds = [];
    for (const [rid, entry] of itemEls) if (entry.row === key) rowIds.push(rid);
    const pos = rowIds.indexOf(id);
    let nextId = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextId = rowIds[(pos + 1) % rowIds.length];
    else nextId = rowIds[(pos - 1 + rowIds.length) % rowIds.length];
    const target = nextId && itemEls.get(nextId);
    if (target && target.el && typeof target.el.focus === 'function') target.el.focus();
  }

  function clear() {
    for (const el of allEls) if (el && typeof el.remove === 'function') el.remove();
    for (const row of rowEls.values()) if (row && typeof row.remove === 'function') row.remove();
    rowEls = new Map();
    itemEls = new Map();
    allEls = [];
    signature = '';
  }

  /**
   * @param {{ active?: boolean, hit?: {id?: string, progress?: number},
   *           tool?: string, color?: string, size?: number, layout?: object }} [next]
   */
  function setState(next) {
    const state = next && typeof next === 'object' ? next : {};
    if (state.layout) build(state.layout);
    else if (state.tool !== undefined) build(layoutPanel({ tool: state.tool })); // 尺寸行随工具变化

    const active = !!state.active;
    host.hidden = !active;
    if (host.setAttribute) host.setAttribute('data-active', active ? 'true' : 'false');
    if (host.setAttribute && state.tool !== undefined) host.setAttribute('data-tool', String(state.tool));

    const hitId = state.hit && state.hit.id ? state.hit.id : null;
    const progress = state.hit && Number.isFinite(Number(state.hit.progress))
      ? Math.max(0, Math.min(1, Number(state.hit.progress)))
      : 0;

    for (const { item, el } of itemEls.values()) {
      const on = isItemActive(item, state);
      el.setAttribute('data-active', on ? 'true' : 'false');
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      const hot = hitId === item.id;
      el.setAttribute('data-hot', hot ? 'true' : 'false');
      if (el.style && typeof el.style.setProperty === 'function') {
        if (hot) el.style.setProperty('--dwell-progress', String(progress));
        else if (typeof el.style.removeProperty === 'function') el.style.removeProperty('--dwell-progress');
      }
      if (el.classList && typeof el.classList.toggle === 'function') el.classList.toggle('is-active', on);
    }
  }

  function destroy() {
    clear();
    if (host.setAttribute) host.setAttribute('data-active', 'false');
    host.hidden = true;
  }

  // 初始：用默认 aspect 先把结构建好，setState 收到 layout 时会自动对齐
  build(null);
  host.hidden = true;
  if (host.setAttribute) host.setAttribute('data-active', 'false');

  return {
    setState,
    destroy,
    setLayout: (l) => build(l),
    element: host,
    items: () => [...itemEls.values()],
    rows: () => [...rowEls.values()],
  };
}

export default createPanelUI;
