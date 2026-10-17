/**
 * 橡皮擦的 2D 模型（纯 canvas 矢量绘制，零下载体积）。
 *
 * 之前橡皮擦在界面里只有一个色环（`render.js` 的 drawCursor）和一个
 * "橡皮擦"文字标签（面板格子）。这里补一个真正的 2D 橡皮造型：
 *   - 光标：橡皮斜握着，擦除端贴着指尖，下面压一圈虚线显示擦除半径；
 *   - 面板：工具格里画出同一块橡皮，下面留一行小字说明。
 *
 * 全部按 `size` 归一化绘制（local 单位 = size），所以 16px 的格子和
 * 60px 的光标用同一份几何，不需要额外的图片资源（也就不会拖慢加载）。
 */

/** 橡皮本体（暖白）、套筒（主题橙）、描边。 */
const ERASER = {
  body: '#f6e8de',
  bodyShade: '#ddc8ba',
  sleeve: '#ff8a5c',
  sleeveShade: '#e06a3c',
  edge: '#fff6ef',
  outline: 'rgba(18, 26, 44, 0.6)',
};

/**
 * 把一条"圆角矩形"路径写进当前路径里（不 beginPath，方便拼复合路径）。
 * @param {CanvasRenderingContext2D} ctx
 */
function roundedBox(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * 画一块 2D 橡皮。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} [options]
 * @param {number} [options.x]      锚点（擦除端）屏幕 x
 * @param {number} [options.y]      锚点（擦除端）屏幕 y
 * @param {number} [options.size]   整块橡皮的长度（像素）
 * @param {number} [options.angle]  旋转弧度，0 = 水平
 * @param {number} [options.alpha]  整体透明度
 * @param {number} [options.press]  下压量 0..1（擦除中会稍微压扁）
 * @param {boolean} [options.anchorTip]  true = (x,y) 是擦除端；false = 中心
 */
export function drawEraserModel(
  ctx,
  { x = 0, y = 0, size = 40, angle = -0.5, alpha = 1, press = 0, anchorTip = true } = {},
) {
  if (!ctx || !(size > 0) || alpha <= 0.01) return;
  const squash = 1 - 0.12 * Math.max(0, Math.min(1, press));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size * squash);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  if (anchorTip) ctx.translate(0.56, 0); // 让 (0,0) 落在左端尖角上

  // 地面阴影：让橡皮"贴"在画面上而不是飘着
  ctx.beginPath();
  ctx.ellipse(0, 0.44, 0.66, 0.1, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(4, 8, 16, 0.35)';
  ctx.fill();

  // 本体（暖白圆角砖）
  ctx.beginPath();
  roundedBox(ctx, -0.6, -0.3, 1.2, 0.6, 0.14);
  ctx.fillStyle = ERASER.body;
  ctx.fill();

  // 侧面阴影：下半部略暗，出一点厚度
  ctx.save();
  ctx.beginPath();
  roundedBox(ctx, -0.6, -0.3, 1.2, 0.6, 0.14);
  ctx.clip();
  ctx.fillStyle = ERASER.bodyShade;
  ctx.fillRect(-0.6, 0.08, 1.2, 0.24);
  // 擦除端（左）磨损成浅色斜面
  ctx.beginPath();
  ctx.moveTo(-0.62, -0.32);
  ctx.lineTo(-0.3, -0.32);
  ctx.lineTo(-0.44, 0.32);
  ctx.lineTo(-0.62, 0.32);
  ctx.closePath();
  ctx.fillStyle = ERASER.edge;
  ctx.fill();
  ctx.restore();

  // 套筒（主题橙的环带）
  ctx.beginPath();
  roundedBox(ctx, -0.1, -0.31, 0.34, 0.62, 0.06);
  ctx.fillStyle = ERASER.sleeve;
  ctx.fill();
  ctx.beginPath();
  roundedBox(ctx, -0.1, 0.1, 0.34, 0.22, 0.06);
  ctx.fillStyle = ERASER.sleeveShade;
  ctx.globalAlpha *= 0.55;
  ctx.fill();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  // 顶面高光
  ctx.beginPath();
  ctx.moveTo(-0.46, -0.2);
  ctx.lineTo(0.34, -0.2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 0.06;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 描边：小尺寸时也要有轮廓感
  ctx.beginPath();
  roundedBox(ctx, -0.6, -0.3, 1.2, 0.6, 0.14);
  ctx.strokeStyle = ERASER.outline;
  ctx.lineWidth = 0.045;
  ctx.stroke();

  ctx.restore();
}

/**
 * 光标形态的橡皮：橡皮 + 一圈虚线擦除半径。
 * 半径用 engine 的 eraserSize 推（半径 ≈ 笔宽 × 2.2），和实际擦除范围对得上。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {number} options.x        指尖屏幕坐标
 * @param {number} options.y
 * @param {number} options.size     橡皮长度（像素）
 * @param {number} options.radius   擦除半径（像素，画虚线环）
 * @param {number} [options.press]
 * @param {number} [options.ratio]  device pixel ratio
 */
export function drawEraserCursor(ctx, { x, y, size, radius, press = 0, ratio = 1 }) {
  if (!ctx) return;
  if (radius > 0) {
    ctx.save();
    ctx.setLineDash([4 * ratio, 5 * ratio]);
    ctx.lineWidth = 1.2 * ratio;
    ctx.strokeStyle = 'rgba(255, 138, 92, 0.55)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  // 橡皮斜握，擦除端落在指尖上；擦除中再压一点角度
  drawEraserModel(ctx, {
    x,
    y,
    size,
    angle: -0.62 - (press > 0.5 ? 0.06 : 0),
    press,
    alpha: 0.97,
  });
}
