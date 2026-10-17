/**
 * Model bundle resolution.
 *
 * Order of preference:
 *   1. ./vendor/models/<name>.task        (local, works offline)
 *   2. published mirror of the same file  (needs internet)
 *
 * The page never hard-fails on a missing local model: it probes, reports what
 * it found in the UI, and falls back to the mirror list. `tools/get_models.py`
 * fills ./vendor/models so the page can run with no network at all.
 */

const MODEL_SOURCES = {
  'hand_landmarker': [
    'vendor/models/hand_landmarker.task',
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/hand_landmarker.task',
  ],
  'pose_landmarker_lite': [
    'vendor/models/pose_landmarker_lite.task',
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  ],
  'face_landmarker': [
    'vendor/models/face_landmarker.task',
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  ],
};

/** Local wasm directory; falls back to the CDN copy of the same version. */
export const WASM_PATHS = {
  local: './vendor/lib/wasm',
  cdn: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
};

async function exists(path) {
  try {
    const res = await fetch(path, { method: 'HEAD' });
    if (!res.ok) return false;
    // A dev server may answer 200 with an HTML directory listing / 404 page.
    const type = res.headers.get('content-type') || '';
    return !type.includes('text/html') || path.endsWith('.js');
  } catch {
    return false;
  }
}

/**
 * Resolve one model to a URL that is guaranteed to be fetchable, or throw with
 * a message the UI can show verbatim.
 * @param {keyof typeof MODEL_SOURCES} name
 */
export async function resolveModel(name) {
  const candidates = MODEL_SOURCES[name];
  if (!candidates) throw new Error(`unknown model "${name}"`);
  const tried = [];
  for (const url of candidates) {
    if (url.startsWith('vendor/')) {
      if (await exists(url)) return { url, local: true };
      tried.push(`${url} (missing)`);
      continue;
    }
    return { url, local: false }; // let the loader surface the network error
  }
  throw new Error(
    `模型文件未找到：${name}。请先运行 "python tools/get_models.py" 把模型下载到 vendor/models/。已尝试：${tried.join('、')}`,
  );
}

/** Pick the local wasm dir when it is present, otherwise the CDN. */
export async function resolveWasmPath() {
  return (await exists('vendor/lib/wasm/vision_wasm_internal.wasm'))
    ? WASM_PATHS.local
    : WASM_PATHS.cdn;
}

/**
 * 把模型文件读进内存，顺带上报进度。
 *
 * 为什么要自己下：`modelAssetPath` 交给 MediaPipe 时拿不到任何进度——
 * 手机上 7.8 MB 的 hand_landmarker.task 加上 9.4 MB wasm，用户只看到一个
 * 卡住不动的页面，以为坏了。拿到 ArrayBuffer 后还能直接喂
 * `modelAssetBuffer`，省掉 MediaPipe 再拉一次。
 *
 * @param {string} url
 * @param {(ratio: number, received: number, total: number) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchModelBuffer(url, onProgress) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`模型下载失败（HTTP ${res.status}）：${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body || typeof res.body.getReader !== 'function' || !total) {
    const whole = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1, whole.byteLength, whole.byteLength);
    return whole;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(Math.min(0.999, received / total), received, total);
    }
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  onProgress?.(1, received, total);
  return out;
}
