/**
 * AirWrite 字符识别器（teammate: recognizer）。
 *
 * 输入是"画布上的实际笔迹"：`[[{x,y}, ...], ...]`，坐标是任意量纲的归一化
 * 值（可能有负值、可能超出 1），所以匹配前一律先做平移/缩放不变处理——
 * 直接复用 features.js 的 bbox 归一化（`normalizeCharacter`，经由
 * `extractFeatures` 调用），不假设输入就是 0..1 的规范字形。
 *
 * 匹配是两条腿：
 *   1) 重采样点序列上的 **DTW**（逐点欧氏距离 + 方向项），照顾笔画走向；
 *   2) features.js 的既有描述子（chamfer 点云 / 8 桶方向直方图 / 4x4 占据栅格 /
 *      长宽比）经 `similarity()` 给出的整体相似度。
 * features.js 刻意保留朝向（6 与 9、M 与 W 靠朝向区分），所以旋转不做全局归一化，
 * 而是用**原型侧的小角度采样**（±14°）覆盖书写倾斜。
 *
 * 约束：纯 ESM、零第三方依赖、不引用 DOM；localStorage 只在函数内部按需
 * `typeof` 判断，Node 里自动降级为内存 Map 并让 saveTemplate 返回 false。
 */

import { STROKES, HIDDEN_KEYS } from './glyphs.js';
import { extractFeatures, similarity } from './features.js';

export const RECOGNIZER_VERSION = 1;

// ------------------------------------------------------------------ 调参 ---
/** 池化重采样后的点数，DTW 两侧都用它。 */
const SAMPLE_COUNT = 40;
/** Sakoe-Chiba 带宽：限制 DTW 只在主对角线附近搜索，省时间也更抗局部拉伸。 */
const DTW_BAND = 9;
/** 原型侧的小角度采样（弧度），覆盖 ±14° 的手腕倾斜。 */
const PROTO_ANGLES = [-14, 0, 14].map((deg) => (deg * Math.PI) / 180);
/** DTW 单元代价里方向项（1 - cos 夹角）的权重。 */
const DTW_DIR_WEIGHT = 0.12;
/** DTW 平均代价 → 相似度的斜率。 */
const DTW_SHARPNESS = 2.8;
/** 两部分的混合权重（DTW 主导，描述子兜底）。 */
const SCORE_DTW = 0.58;
const SCORE_FEATURE = 0.42;
/** 笔画数不一致时的乘性惩罚（每笔 5%，最多 3 笔）。 */
const STROKE_PENALTY = 0.05;
/** 低于该分数就当成"没认出来"，返回 key = null。 */
const MIN_SCORE = 0.52;
/** candidates 最多返回多少个（契约：最多 5 个）。 */
const MAX_CANDIDATES = 5;
/** 用户模板的 localStorage 键名。 */
const USER_STORAGE_KEY = 'airwrite:user-templates:v1';

// -------------------------------------------------------------- 小工具 ---
const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const round4 = (value) => Math.round(value * 10000) / 10000;
const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 空的识别结果（每次返回新对象，调用方可以随便改）。 */
const emptyResult = () => ({ key: null, text: '', confidence: 0, candidates: [] });

/**
 * 把外部输入清成 `[[{x,y}, ...], ...]`。
 * 容忍 `[x, y]` 数组点、非数组笔画、NaN 点；畸形数据直接丢掉，永不抛错。
 */
function sanitizeStrokes(raw) {
  if (!Array.isArray(raw)) return [];
  const strokes = [];
  for (const rawStroke of raw) {
    if (!Array.isArray(rawStroke)) continue;
    const points = [];
    for (const rawPoint of rawStroke) {
      const x = Number(Array.isArray(rawPoint) ? rawPoint[0] : rawPoint?.x);
      const y = Number(Array.isArray(rawPoint) ? rawPoint[1] : rawPoint?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push({ x, y });
    }
    if (points.length) strokes.push(points);
  }
  return strokes;
}

/** 拍平所有点（只读用途）。 */
function flatten(strokes) {
  const out = [];
  for (const stroke of strokes) for (const p of stroke) out.push(p);
  return out;
}

/**
 * 点集的包围盒（本地实现，避免依赖别的 teammate 的 vision/smoothing.js）。
 * 空输入返回全 0，调用方永远不会拿到 NaN。
 */
function pointsBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, centerX: 0, centerY: 0 };
  const width = maxX - minX;
  const height = maxY - minY;
  return { minX, minY, maxX, maxY, width, height, centerX: minX + width / 2, centerY: minY + height / 2 };
}

/**
 * features.js 的 `extractFeatures` 用原始单位的 `inkLength < 4` 挡住"墨太少"，
 * 而我们的输入是 0..1 量纲（整字墨长往往只有 1~3），会把正常笔迹误杀。
 * 这里先把整字等比缩放到"最大边 = 100"再交给它——bbox 归一化本身与尺度无关，
 * 所以除了 inkLength/bounds 之外，得到的特征完全一样。
 */
function featureScale(strokes) {
  const bounds = pointsBounds(flatten(strokes));
  const span = Math.max(bounds.width, bounds.height);
  const k = span > 1e-6 ? 100 / span : 100;
  return strokes.map((stroke) => stroke.map((p) => ({ x: p.x * k, y: p.y * k })));
}

/** 绕整字中心旋转（只在构造原型描述子时用）。 */
function rotateStrokes(strokes, angle) {
  if (!angle) return strokes;
  const bounds = pointsBounds(flatten(strokes));
  const cx = bounds.centerX;
  const cy = bounds.centerY;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return strokes.map((stroke) =>
    stroke.map((p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    }),
  );
}

/** 每个点的单位切向（用相邻点差分；退化点沿用上一个方向）。 */
function unitDirections(points) {
  const dirs = new Array(points.length);
  let last = { x: 0, y: 0 };
  for (let i = 0; i < points.length; i += 1) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) last = { x: dx / len, y: dy / len };
    dirs[i] = last;
  }
  return dirs;
}

/**
 * 构造一份可比较的描述子（旋转 angle 之后）。
 * @returns {{points:Array, dirs:Array, features:object, strokeCount:number}|null}
 */
function buildDescriptor(strokes, angle = 0) {
  const features = extractFeatures(featureScale(rotateStrokes(strokes, angle)), { samples: SAMPLE_COUNT });
  if (!features || features.points.length < 2) return null;
  return {
    points: features.points,
    dirs: unitDirections(features.points),
    features,
    strokeCount: features.strokeCount,
  };
}

/**
 * 带宽受限的 DTW，返回平均每点代价（含方向项）。
 * 序列长度不同时自动把带宽放宽 |n-m|，保证终点可达。
 */
function dtwCost(a, b) {
  const n = a.points.length;
  const m = b.points.length;
  const slack = Math.abs(n - m);
  const band = DTW_BAND + slack;
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;
  for (let i = 1; i <= n; i += 1) {
    cur.fill(Infinity);
    const lo = Math.max(1, i - band);
    const hi = Math.min(m, i + band);
    for (let j = lo; j <= hi; j += 1) {
      const p = a.points[i - 1];
      const q = b.points[j - 1];
      let cost = Math.hypot(p.x - q.x, p.y - q.y);
      const da = a.dirs[i - 1];
      const db = b.dirs[j - 1];
      cost += DTW_DIR_WEIGHT * (1 - (da.x * db.x + da.y * db.y));
      let best = prev[j];
      if (prev[j - 1] < best) best = prev[j - 1];
      if (cur[j - 1] < best) best = cur[j - 1];
      cur[j] = cost + best;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const total = prev[m];
  return Number.isFinite(total) ? total / Math.max(n, m) : 1;
}

/** 输入描述子 vs 原型描述子 → 0..1 相似度。 */
function scorePair(input, proto) {
  const simDtw = clamp01(1 - dtwCost(input, proto) * DTW_SHARPNESS);
  const simFeature = similarity(input.features, proto.features);
  const gap = Math.min(3, Math.abs(input.strokeCount - proto.strokeCount));
  return clamp01((SCORE_DTW * simDtw + SCORE_FEATURE * simFeature) * (1 - STROKE_PENALTY * gap));
}

/**
 * 把 glyphs.js 的 `[[[x, y], ...], ...]` 转成 `[[{x,y}, ...], ...]`。
 * glyphs.js 里 `'0c'..'7c'` 是 `['0']` 这种字符串占位（见文件末尾的 CURVY 循环），
 * 不是点数据，这里直接跳过，避免污染原型库。
 */
function glyphStrokes(shapes) {
  if (!Array.isArray(shapes)) return [];
  const out = [];
  for (const shape of shapes) {
    if (!Array.isArray(shape)) continue;
    const points = [];
    for (const pair of shape) {
      const x = Number(pair?.[0]);
      const y = Number(pair?.[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }
    if (points.length) out.push(points);
  }
  return out;
}

/** 只在函数内碰 localStorage，Node 下返回 null。 */
function storageArea() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 部分隐私模式下连 typeof 访问都会抛
    return null;
  }
}

/**
 * 创建一个识别器。
 * @param {{glyphs?: object}} [options] glyphs 省略时用 glyphs.js 的 STROKES
 */
export function createRecognizer({ glyphs } = {}) {
  const table = glyphs && typeof glyphs === 'object' ? glyphs : STROKES;
  /** 用户模板：key -> [{ strokes, text }] */
  const userTemplates = new Map();
  /** 全部原型（内置 + 用户），每项含 key/text/descriptor。 */
  let prototypes = [];
  /** 内置可见键（保持 glyphs.js 的插入顺序：数字、字母、符号）。 */
  let visibleKeys = [];
  /** 每个可见键内置了多少份原始样本（'8'/'9' 有 curvy 变体，所以是 2）。 */
  let builtinSamples = new Map();

  /** 读取 localStorage 里的用户模板；任何异常都退化成空表。 */
  function loadUserTemplates() {
    const store = storageArea();
    if (!store) return;
    try {
      const raw = store.getItem(USER_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const [key, list] of Object.entries(parsed)) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const strokes = sanitizeStrokes(item?.strokes);
          if (!strokes.length) continue;
          const bucket = userTemplates.get(String(key)) ?? [];
          bucket.push({ strokes, text: typeof item?.text === 'string' ? item.text : String(key) });
          userTemplates.set(String(key), bucket);
        }
      }
    } catch {
      // 存储损坏就当作没有用户模板
    }
  }

  /** 写回 localStorage；没有 localStorage（Node）时返回 false。 */
  function persistUserTemplates() {
    const store = storageArea();
    if (!store) return false;
    try {
      const payload = {};
      for (const [key, list] of userTemplates) {
        payload[key] = list.map((item) => ({
          text: item.text,
          strokes: item.strokes.map((stroke) => stroke.map((p) => ({ x: round4(p.x), y: round4(p.y) }))),
        }));
      }
      store.setItem(USER_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** 重建原型库（内置 + 用户），每个样本在 3 个角度上各生成一份描述子。 */
  function rebuild() {
    prototypes = [];
    visibleKeys = [];
    builtinSamples = new Map();
    const seen = new Set();

    for (const [rawKey, shapes] of Object.entries(table)) {
      const hidden = HIDDEN_KEYS.has(rawKey);
      // '8c' -> '8'：curvy 变体只作为同一字符的额外原型，不作为独立答案
      const key = hidden ? rawKey.replace(/c$/, '') : rawKey;
      const strokes = glyphStrokes(shapes);
      if (!strokes.length) continue;
      for (const angle of PROTO_ANGLES) {
        const descriptor = buildDescriptor(strokes, angle);
        if (descriptor) prototypes.push({ key, text: key, descriptor });
      }
      builtinSamples.set(key, (builtinSamples.get(key) ?? 0) + 1);
      if (!hidden && !seen.has(key)) {
        seen.add(key);
        visibleKeys.push(key);
      }
    }

    for (const [key, list] of userTemplates) {
      for (const item of list) {
        for (const angle of PROTO_ANGLES) {
          const descriptor = buildDescriptor(item.strokes, angle);
          if (descriptor) prototypes.push({ key, text: item.text || key, descriptor });
        }
      }
    }
  }

  loadUserTemplates();
  rebuild();

  /**
   * 识别一组笔画。
   * @param {Array<Array<{x:number,y:number}>>} rawStrokes
   * @returns {{key:(string|null), text:string, confidence:number, candidates:Array<{key:string,score:number}>}}
   */
  function recognize(rawStrokes) {
    try {
      const strokes = sanitizeStrokes(rawStrokes);
      if (!strokes.length || !prototypes.length) return emptyResult();
      const input = buildDescriptor(strokes, 0);
      if (!input) return emptyResult();

      // 同一 key 只保留最高分（curvy 变体/多份模板共享一个 key）
      const best = new Map();
      for (const proto of prototypes) {
        const score = scorePair(input, proto.descriptor);
        const prev = best.get(proto.key);
        if (!prev || score > prev.score) best.set(proto.key, { key: proto.key, text: proto.text, score });
      }
      if (!best.size) return emptyResult();

      const ranked = [...best.values()].sort((a, b) => b.score - a.score || compareKeys(a.key, b.key));
      const candidates = ranked.slice(0, MAX_CANDIDATES).map((c) => ({ key: c.key, score: round4(c.score) }));
      const top = ranked[0];
      if (!top || top.score < MIN_SCORE) return { key: null, text: '', confidence: 0, candidates };
      return {
        key: top.key,
        text: top.text || top.key,
        confidence: round4(clamp01(top.score)),
        candidates,
      };
    } catch {
      // 识别器永不抛错：任何异常都退化成"没认出来"
      return emptyResult();
    }
  }

  /**
   * 追加一份用户模板。
   * @returns {boolean} 是否成功写进 localStorage（Node 无 localStorage 时为 false，但内存里已生效）
   */
  function saveTemplate(key, rawStrokes, options = {}) {
    try {
      const name = key === null || key === undefined ? '' : String(key).trim();
      const strokes = sanitizeStrokes(rawStrokes);
      if (!name || !strokes.length) return false;
      const text = typeof options?.text === 'string' && options.text ? options.text : name;
      const bucket = userTemplates.get(name) ?? [];
      bucket.push({ strokes, text });
      userTemplates.set(name, bucket);
      rebuild();
      return persistUserTemplates();
    } catch {
      return false;
    }
  }

  /** 内置 + 用户模板的只读摘要（按样本数计，不按角度变体计）。 */
  function templates() {
    try {
      const out = [];
      const seen = new Set();
      for (const key of visibleKeys) {
        seen.add(key);
        out.push({ key, samples: (builtinSamples.get(key) ?? 0) + (userTemplates.get(key)?.length ?? 0) });
      }
      for (const [key, list] of userTemplates) {
        if (!seen.has(key)) out.push({ key, samples: list.length });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 内置的可见字符集（顺序即 UI 顺序：数字、字母、符号）。 */
  function builtinKeys() {
    return visibleKeys.slice();
  }

  /** 清空用户模板（内存 + localStorage）。 */
  function clearUserTemplates() {
    try {
      userTemplates.clear();
      const store = storageArea();
      if (store) store.removeItem(USER_STORAGE_KEY);
      rebuild();
      return true;
    } catch {
      return false;
    }
  }

  return { recognize, saveTemplate, templates, builtinKeys, clearUserTemplates };
}

export default createRecognizer;
