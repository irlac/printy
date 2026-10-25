// Shared test harness for Printy — loads the real index.html script with
// DOM/canvas stubs and returns the app's internals for testing.
// Usage: const T = require('./harness.js').loadApp();
'use strict';
const fs = require('fs');

function parseColor(s) {
  s = String(s).toLowerCase().trim();
  if (s === '#fff' || s === '#ffffff' || s === 'white') return 255;
  if (s === '#000' || s === '#000000' || s === 'black') return 0;
  const m = s.match(/^#([0-9a-f]{6})$/);
  if (m) { const v = parseInt(m[1], 16); return Math.round(((v >> 16 & 255) + (v >> 8 & 255) + (v & 255)) / 3); }
  return 128;
}
function fontSizeOf(f) { const m = String(f).match(/(\d+(?:\.\d+)?)px/); return m ? +m[1] : 10; }
function makeCtx(cv) {
  const t = {
    _cv: cv, _fill: '#000', _font: '10px sans-serif', _align: 'left', _base: 'alphabetic', _lw: 1,
    set fillStyle(v) { this._fill = parseColor(v); }, get fillStyle() { return '#000'; },
    set font(v) { this._font = v; }, get font() { return this._font; },
    set textAlign(v) { this._align = v; }, get textAlign() { return this._align; },
    set textBaseline(v) { this._base = v; }, get textBaseline() { return this._base; },
    set lineWidth(v) { this._lw = v; }, get lineWidth() { return this._lw; },
    save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, stroke() {}, arc() {}, rect() {}, fill() {}, clip() {},
    clearRect(x, y, w, h) { const o = this._fill; this._fill = 255; this.fillRect(x, y, w, h); this._fill = o; },
    fillRect(x, y, w, h) {
      const {_w: W, _h: H, _buf: b} = this._cv, v = this._fill;
      if (!b) return;
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * W + xx) * 4; b[i] = b[i + 1] = b[i + 2] = v; b[i + 3] = 255;
      }
    },
    measureText(s) { return {width: String(s).length * fontSizeOf(this._font) * 0.6}; },
    fillText(s, x, y) {
      const fs = fontSizeOf(this._font), w = this.measureText(s).width;
      let xx = x; if (this._align === 'center') xx = x - w / 2; else if (this._align === 'right') xx = x - w;
      this.fillRect(xx, y, Math.max(1, w), Math.max(1, fs));
    },
    drawImage(src, ...a) {
      let sx = 0, sy = 0, sw = src._w, sh = src._h, dx, dy, dw, dh;
      if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; }
      else if (a.length === 4) { [dx, dy, dw, dh] = a; }
      else if (a.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
      else return;
      const D = this._cv, S = src;
      if (!D._buf || !S._buf || !sw || !sh) return;
      dx = Math.round(dx); dy = Math.round(dy); dw = Math.round(dw); dh = Math.round(dh);
      for (let yy = 0; yy < dh; yy++) for (let xx = 0; xx < dw; xx++) {
        const tx = dx + xx, ty = dy + yy;
        if (tx < 0 || ty < 0 || tx >= D._w || ty >= D._h) continue;
        const px = Math.min(S._w - 1, Math.floor(sx + xx * sw / dw)), py = Math.min(S._h - 1, Math.floor(sy + yy * sh / dh));
        const si = (py * S._w + px) * 4, di = (ty * D._w + tx) * 4;
        D._buf[di] = S._buf[si]; D._buf[di + 1] = S._buf[si + 1]; D._buf[di + 2] = S._buf[si + 2]; D._buf[di + 3] = 255;
      }
    },
    getImageData(x, y, w, h) {
      const {_w: W, _buf: b} = this._cv, out = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const si = ((y + yy) * W + (x + xx)) * 4, di = (yy * w + xx) * 4;
        out[di] = b[si]; out[di + 1] = b[si + 1]; out[di + 2] = b[si + 2]; out[di + 3] = b[si + 3];
      }
      return {width: w, height: h, data: out};
    },
    putImageData(id, dx, dy) {
      const {_w: W, _h: H, _buf: b} = this._cv;
      for (let yy = 0; yy < id.height; yy++) for (let xx = 0; xx < id.width; xx++) {
        const tx = dx + xx, ty = dy + yy;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const si = (yy * id.width + xx) * 4, di = (ty * W + tx) * 4;
        b[di] = id.data[si]; b[di + 1] = id.data[si + 1]; b[di + 2] = id.data[si + 2]; b[di + 3] = 255;
      }
    },
    createImageData(w, h) { return {width: w, height: h, data: new Uint8ClampedArray(w * h * 4)}; },
  };
  return new Proxy(t, {
    get(o, k) { if (k in o) return o[k]; return () => {}; },
    set(o, k, v) { o[k] = v; return true; },
  });
}
function makeCanvas() {
  const cv = {_w: 0, _h: 0, _buf: null, _ctx: null,
    get width() { return this._w; }, set width(v) { this._w = v; this._alloc(); },
    get height() { return this._h; }, set height(v) { this._h = v; this._alloc(); },
    _alloc() { if (this._w > 0 && this._h > 0) this._buf = new Uint8ClampedArray(this._w * this._h * 4).fill(255); },
    getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; },
  };
  return cv;
}
function makeEl(id) {
  const cv = makeCanvas();
  return {
    id, value: '', textContent: '', innerHTML: '', disabled: false, className: '', dataset: {}, style: {},
    get width() { return cv.width; }, set width(v) { cv.width = v; },
    get height() { return cv.height; }, set height(v) { cv.height = v; },
    getContext: (...a) => cv.getContext(...a),
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, prepend() {}, setAttribute() {},
    insertAdjacentHTML() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: {contains: () => false, toggle() {}, add() {}, remove() {}},
    click() {}, focus() {}, select() {},
  };
}

function installStubs() {
  const elCache = {};
  global.document = {
    createElement: t => t === 'canvas' ? makeCanvas() : makeEl(t),
    getElementById: id => elCache[id] || (elCache[id] = makeEl(id)),
    querySelector: sel => sel === '#tab-studio' ? {classList: {contains: () => true}} : makeEl('q'),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  global.window = global; global.self = global;
  global.localStorage = {_m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; }};
  global.Image = function() {
    const cv = makeCanvas(); cv.width = 200; cv.height = 150;
    const c = cv.getContext('2d');
    for (let y = 0; y < 150; y += 10) for (let x = 0; x < 200; x += 10) { c.fillStyle = ((x + y) / 10) % 2 ? '#000' : '#fff'; c.fillRect(x, y, 10, 10); }
    const im = {naturalWidth: 200, naturalHeight: 150, _w: 200, _h: 150, _buf: cv._buf, crossOrigin: null, onload: null, onerror: null, _src: ''};
    Object.defineProperty(im, 'src', {set(v) { im._src = v; const cb = im.onload; if (cb) setTimeout(() => cb(), 0); }, get() { return im._src; }});
    return im;
  };
  global.FileReader = function() {};
  global.confirm = () => true;
  if (global.URL) {
    global.URL.createObjectURL = () => 'blob:test';
    global.URL.revokeObjectURL = () => {};
  }
}

function loadApp() {
  installStubs();
  const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no script in index.html');
  eval(m[1] + '\n;globalThis.__T={streamRaster,printJob,buildJob,jobHeadBytes,rasterSegmentHeader,JOB_FOOT,PKG_END,engineState,makeJobCtl,CancelledError,renderSourceRows,makeBandDither,packBitsFromBin,queueGeom,parsePages,scanSourceBbox,queueRowStream,newCanvas,canvasToGray,applyLevels,dither,queueKindFor};');
  return globalThis.__T;
}

module.exports = {loadApp, makeCanvas, makeEl};
