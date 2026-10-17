/**
 * Video-space -> canvas-space mapping.
 *
 * The canvas is the full viewport and the video is displayed with
 * `object-fit: cover`. A landmark is normalized to the *video* rect, so scaling
 * it by the canvas size is only correct when the two aspect ratios match. These
 * helpers reproduce the cover fit (and can optionally crop-zoom), which keeps
 * the skeleton glued to the preview on 4:3 webcams and on phones.
 */

export class ViewMapper {
  constructor() {
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this._scale = 1;
    this._dx = 0;
    this._dy = 0;
  }

  setViewport(canvasWidth, canvasHeight, videoWidth, videoHeight) {
    if (
      canvasWidth === this.canvasWidth &&
      canvasHeight === this.canvasHeight &&
      videoWidth === this.videoWidth &&
      videoHeight === this.videoHeight
    ) {
      return;
    }
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    this.#recompute();
  }

  /** Extra magnification around the viewport center, 1 = exact cover fit. */
  setZoom(zoom) {
    this.zoom = Math.max(0.4, Math.min(3.2, zoom));
    this.#recompute();
  }

  /**
   * Pan the drawn video in canvas pixels (the air-write zoom gesture moves the
   * view with the palm, so this is the "平移" half of 放大/缩小).
   */
  setPan(offsetX, offsetY) {
    const x = Number.isFinite(offsetX) ? offsetX : 0;
    const y = Number.isFinite(offsetY) ? offsetY : 0;
    if (x === this.offsetX && y === this.offsetY) return;
    this.offsetX = x;
    this.offsetY = y;
    this.#recompute();
  }

  #recompute() {
    if (!this.videoWidth || !this.videoHeight || !this.canvasWidth) return;
    const cover = Math.max(
      this.canvasWidth / this.videoWidth,
      this.canvasHeight / this.videoHeight,
    );
    this._scale = cover * this.zoom;
    const drawnW = this.videoWidth * this._scale;
    const drawnH = this.videoHeight * this._scale;
    this._dx = (this.canvasWidth - drawnW) / 2 + this.offsetX;
    this._dy = (this.canvasHeight - drawnH) / 2 + this.offsetY;
  }

  /** Normalized video coords (0..1) -> canvas pixels. */
  point(p) {
    return { x: this._dx + p.x * this.videoWidth * this._scale, y: this._dy + p.y * this.videoHeight * this._scale };
  }

  toX(nx) {
    return this._dx + nx * this.videoWidth * this._scale;
  }

  toY(ny) {
    return this._dy + ny * this.videoHeight * this._scale;
  }

  /** A length expressed in normalized-video units -> canvas pixels. */
  length(n) {
    return n * this.videoWidth * this._scale;
  }

  /**
   * Canvas pixels -> normalized video coords (the inverse of `point()`).
   * Used by pointer/mouse input: the ink recorder works in video space, so a
   * click has to be un-projected through the same cover fit + zoom + pan that
   * drew the preview, otherwise the stroke lands away from the cursor on any
   * viewport whose aspect ratio differs from the camera's.
   */
  unproject(x, y) {
    const sx = this.videoWidth * this._scale;
    const sy = this.videoHeight * this._scale;
    return {
      x: sx ? (x - this._dx) / sx : 0,
      y: sy ? (y - this._dy) / sy : 0,
    };
  }

  /** Pixels per normalized unit along x (useful for particle velocity). */
  get pixelScale() {
    return this.videoWidth * this._scale;
  }
}
