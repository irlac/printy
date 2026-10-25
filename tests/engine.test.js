// Print Engine 2.0 tests — run with: node tests/engine.test.js
// Loads the real index.html script with DOM stubs (same pattern as the
// original studiotest harness) and drives the engine against SimTransport.
// No Bluetooth, no printer, no network required.
'use strict';
const fs = require('fs');
const {SimTransport} = require('./sim-transport.js');

/* ---------- minimal raster canvas (copied pattern from studiotest) ---------- */
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

/* ---------- load the app ---------- */
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.log('FATAL: no script'); process.exit(1); }
eval(m[1] + '\n;globalThis.__T={streamRaster,printJob,buildJob,jobHeadBytes,rasterSegmentHeader,JOB_FOOT,PKG_END,engineState,makeJobCtl,CancelledError};');
const T = globalThis.__T;

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL:', msg); } else console.log('ok:', msg); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const FAST = {gapMs: 0, chunkBytes: 1024};
const BIGCAP = {maxSegmentRows: 100000};
function makeBmp(rows, fill) {
  const bmp = new Uint8Array(48 * rows);
  if (fill === 'black') bmp.fill(0xff);
  else if (fill === 'stripe') for (let y = 0; y < rows; y++) for (let x = 0; x < 48; x++) bmp[y * 48 + x] = (y % 2) ? 0xaa : 0x55;
  else if (fill === 'random') { let s = 12345; for (let i = 0; i < bmp.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; bmp[i] = s >> 16; } }
  return bmp;
}
async function* blocksOf(bmp, blockRows) {
  for (let o = 0; o < bmp.length; o += blockRows * 48) yield bmp.slice(o, o + blockRows * 48);
}

(async () => {
  // 1. Small job through the new engine is byte-identical to the legacy encoder.
  {
    const bmp = makeBmp(64, 'stripe');
    const sim = new SimTransport();
    const r = await T.printJob(bmp, 64, {transport: sim, ...FAST});
    ok(eq(sim.allBytes, T.buildJob(bmp, 64)), 'small job bytes == legacy buildJob bytes');
    ok(r.sentRows === 64 && r.segments === 1, 'small job = 1 segment');
    ok(sim.headReceived && sim.footReceived && !sim.discarded && !sim.parseError, 'small job parses clean');
  }
  // 2. Split mode (opt-in): 300 rows with maxRows 128 -> 128 + 128 + 44,
  //    one head, one foot, nothing between.
  {
    const bmp = makeBmp(300, 'random');
    const sim = new SimTransport();
    await T.printJob(bmp, 300, {transport: sim, ...FAST, maxRows: 128});
    ok(sim.segments.map(s => s.rows).join(',') === '128,128,44', 'split 300 rows -> 128/128/44 (got ' + sim.segments.map(s => s.rows).join(',') + ')');
    ok(sim.footReceived && sim.segments.length === 3, 'one foot after 3 split blocks');
    ok(eq(sim.raster, bmp), 'split raster reconstructs exactly');
  }
  // 3. THE 2.0 DIAGNOSIS: legacy single-block tall job is discarded (blank);
  //    the split engine prints the same bitmap in full under the same cap.
  {
    const bmp = makeBmp(1000, 'random');
    const legacy = T.buildJob(bmp, 1000); // one GS v 0 with height=1000
    const simOld = new SimTransport({maxSegmentRows: 255});
    for (let o = 0; o < legacy.length; o += 1024) await simOld.write(legacy.slice(o, o + 1024));
    ok(simOld.discarded && simOld.rowsReceived === 0, 'legacy 1000-row single block discarded -> blank output');
    const simNew = new SimTransport({maxSegmentRows: 255});
    await T.printJob(bmp, 1000, {transport: simNew, ...FAST, maxRows: 128});
    ok(!simNew.discarded && simNew.rowsReceived === 1000, 'split engine prints all 1000 rows under the same cap');
    ok(eq(simNew.raster, bmp), 'split 1000-row raster byte-exact, no missing/duplicated rows');
  }
  // 4. Multi-item queue stream: blocks + spacing concatenate in order
  //    (one package by default; high-cap sim so the block itself is not capped).
  {
    const a = makeBmp(100, 'stripe'), b = makeBmp(200, 'black'), gap = new Uint8Array(48 * 24);
    const total = 100 + 24 + 200;
    const sim = new SimTransport(BIGCAP);
    async function* src() { yield a; yield gap; yield b; }
    const r = await T.streamRaster(src(), total, {transport: sim, ...FAST, label: 'queue test'});
    const expect = new Uint8Array(48 * total);
    expect.set(a, 0); expect.set(gap, 48 * 100); expect.set(b, 48 * 124);
    ok(eq(sim.raster, expect), 'queue blocks + spacing concatenate in order');
    ok(r.sentRows === total, 'queue sentRows == total');
  }
  // 5. Disconnect mid-print: engine throws, state failed, no foot, no resend.
  //    (One 1000-row package now; the sim dies inside the package's data.)
  {
    const bmp = makeBmp(1000, 'random');
    const sim = new SimTransport({failAfterBytes: 11 + 8 + 6144 + 8 + 1000});
    let threw = null;
    try { await T.printJob(bmp, 1000, {transport: sim, ...FAST}); } catch (e) { threw = e; }
    ok(!!threw && /disconnect/.test(threw.message), 'disconnect throws (got: ' + (threw && threw.message) + ')');
    ok(T.engineState.state === 'failed', 'state failed after disconnect (got ' + T.engineState.state + ')');
    ok(!sim.footReceived, 'no footer after failure');
    ok(T.engineState.sentRows < 1000, 'sentRows < total after disconnect (' + T.engineState.sentRows + ')');
  }
  // 6. Cancel mid-print: clean stop, no foot, state cancelled.
  //    (Split mode so a block boundary exists at 128 rows to stop at.)
  {
    const bmp = makeBmp(1000, 'random');
    const sim = new SimTransport();
    const ctl = T.makeJobCtl();
    const r = await T.printJob(bmp, 1000, {transport: sim, ...FAST, maxRows: 128, ctl,
      onProgress: (sent) => { if (sent >= 128) ctl.cancelled = true; }});
    ok(r.cancelled === true, 'cancel returns cancelled:true');
    ok(T.engineState.state === 'cancelled', 'state cancelled');
    ok(!sim.footReceived, 'no footer after cancel');
    ok(sim.rowsReceived === 128, 'cancel stops at a block boundary (128 rows, got ' + sim.rowsReceived + ')');
  }
  // 7. Pause/resume: full raster, no duplicates, state really passes through paused.
  //    (Split mode so a block boundary exists at 128 rows to pause at.)
  {
    const bmp = makeBmp(300, 'stripe');
    const sim = new SimTransport();
    const ctl = T.makeJobCtl();
    let sawPaused = false;
    const poll = setInterval(() => { if (T.engineState.state === 'paused') sawPaused = true; }, 20);
    const r = await T.printJob(bmp, 300, {transport: sim, ...FAST, maxRows: 128, ctl,
      onProgress: (sent) => {
        if (sent === 128 && !ctl.paused) {
          ctl.paused = true;
          setTimeout(() => { ctl.paused = false; }, 250);
        }
      }});
    clearInterval(poll);
    ok(r.sentRows === 300 && eq(sim.raster, bmp), 'pause/resume prints all rows exactly once');
    ok(sawPaused, 'engine state observed as paused mid-job');
    ok(T.engineState.state === 'completed', 'state completed after resume');
  }
  // 8. Dense black: 512 rows of solid black reconstruct exactly.
  {
    const bmp = makeBmp(512, 'black');
    const sim = new SimTransport(BIGCAP);
    await T.printJob(bmp, 512, {transport: sim, ...FAST});
    ok(eq(sim.raster, bmp) && sim.rowsReceived === 512, 'dense black 512 rows byte-exact');
  }
  // 9. Row alignment: random bitmap, every row lands at its own offset.
  {
    const bmp = makeBmp(257, 'random');
    const sim = new SimTransport(BIGCAP);
    await T.printJob(bmp, 257, {transport: sim, ...FAST});
    let aligned = true;
    for (let y = 0; y < 257; y++) for (let x = 0; x < 48; x++)
      if (sim.raster[y * 48 + x] !== bmp[y * 48 + x]) { aligned = false; break; }
    ok(aligned, '257 random rows all aligned (no off-by-one at block seams)');
  }
  // 10. Empty job is refused, not printed as blank paper.
  {
    const sim = new SimTransport();
    let threw = null;
    try { await T.streamRaster((async function* () {})(), 0, {transport: sim, ...FAST}); } catch (e) { threw = e; }
    ok(!!threw && /nothing to print/.test(threw.message), 'empty job refused');
    ok(!sim.headReceived, 'empty job sent nothing to the printer');
  }
  // 11. Two jobs back-to-back: second job re-inits cleanly after the first.
  {
    const sim = new SimTransport();
    await T.printJob(makeBmp(50, 'stripe'), 50, {transport: sim, ...FAST});
    const sim2 = new SimTransport();
    await T.printJob(makeBmp(50, 'black'), 50, {transport: sim2, ...FAST});
    ok(sim2.headReceived && sim2.footReceived && sim2.rowsReceived === 50, 'second job after first completes cleanly');
  }
  // 12. Package mode: a 1000-row single image goes out as ONE block, byte-exact.
  {
    const bmp = makeBmp(1000, 'random');
    const sim = new SimTransport(BIGCAP);
    const r = await T.printJob(bmp, 1000, {transport: sim, ...FAST});
    ok(sim.segments.map(s => s.rows).join(',') === '1000', 'tall image = 1 package block (got ' + sim.segments.map(s => s.rows).join(',') + ')');
    ok(r.segments === 1 && eq(sim.raster, bmp), 'tall package reconstructs byte-exact');
  }
  // Helper: reconstructed output with feed runs removed (feeds are in
  // reconstructed coordinates, so stripping them recovers sent data).
  function stripFeeds(sim) {
    const rows = sim.raster.length / 48;
    const feedSet = new Set();
    for (const f of sim.feeds) for (let y = f.at; y < f.at + f.rows; y++) feedSet.add(y);
    const out = [];
    for (let y = 0; y < rows; y++)
      if (!feedSet.has(y)) for (let x = 0; x < 48; x++) out.push(sim.raster[y * 48 + x]);
    return new Uint8Array(out);
  }
  // 13. BUG REPRODUCTION (the reported issue): with the old 128-row cuts,
  //     the printer's post-block feed lands INSIDE the image.
  {
    const bmp = makeBmp(300, 'stripe'); // stripe rows are never all-zero
    const sim = new SimTransport({feedRows: 100});
    await T.printJob(bmp, 300, {transport: sim, ...FAST, maxRows: 128});
    ok(sim.feeds.length === 3, 'split image triggers 3 post-block feeds (got ' + sim.feeds.length + ')');
    ok(sim.feeds[0].at === 128, 'first feed at row 128, inside the image span 0-299');
    let feedBlank = true;
    for (let y = 128; y < 228; y++)
      for (let x = 0; x < 48; x++)
        if (sim.raster[y * 48 + x] !== 0) feedBlank = false;
    ok(feedBlank, 'rows 128-227 of the output are feed blank, not image data -> shredded');
  }
  // 14. THE FIX: two images as packages with a 24-row break between them.
  //     Feeds land only between images, never inside one.
  {
    const img1 = makeBmp(100, 'stripe'), img2 = makeBmp(200, 'black');
    const brk = new Uint8Array(48 * 24);
    const total = 100 + 24 + 200;
    const sim = new SimTransport({...BIGCAP, feedRows: 100});
    async function* src() { yield img1; yield T.PKG_END; yield brk; yield img2; yield T.PKG_END; }
    const r = await T.streamRaster(src(), total, {transport: sim, ...FAST});
    ok(sim.segments.map(s => s.rows).join(',') === '100,224', 'packages: [img1 100, break+img2 224] (got ' + sim.segments.map(s => s.rows).join(',') + ')');
    ok(sim.feeds.map(f => f.at).join(',') === '100,424', 'feeds at 100 and 424 = package boundaries only (got ' + sim.feeds.map(f => f.at).join(',') + ')');
    // Image data ranges in reconstructed coordinates: img1 [0,100), img2 [224,424).
    const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
    const badFeed = sim.feeds.some(f => overlaps(f.at, f.at + f.rows, 0, 100) || overlaps(f.at, f.at + f.rows, 224, 424));
    ok(!badFeed, 'no feed overlaps any image data range');
    const data = stripFeeds(sim);
    const expect = new Uint8Array(48 * total);
    expect.set(img1, 0); expect.set(brk, 48 * 100); expect.set(img2, 48 * 124);
    ok(eq(data, expect), 'data minus feeds == img1 + break + img2, byte-exact');
    ok(r.sentRows === total, 'package job sentRows == total');
  }
  // 15. Split-mode tradeoff, documented: cutting a package reintroduces
  //     feeds inside the image. Splitting is a fallback, not the default.
  {
    const bmp = makeBmp(300, 'stripe');
    const sim = new SimTransport({feedRows: 100});
    await T.printJob(bmp, 300, {transport: sim, ...FAST, maxRows: 128});
    ok(sim.feeds[0].at === 128 && sim.feeds[0].at < 300, 'split package: first feed inside the image span (row 128 < 300)');
  }
  // 16. No blank-only block: break rows ride with the FOLLOWING package,
  //     so no block is all blank (which would waste a feed on nothing).
  {
    const img1 = makeBmp(100, 'stripe'), img2 = makeBmp(200, 'black');
    const brk = new Uint8Array(48 * 24);
    const sim = new SimTransport({...BIGCAP, feedRows: 100});
    async function* src() { yield img1; yield T.PKG_END; yield brk; yield img2; yield T.PKG_END; }
    await T.streamRaster(src(), 324, {transport: sim, ...FAST});
    let allNonBlank = true;
    for (const s of sim.segments) {
      let nz = false;
      for (let y = s.at; y < s.at + s.rows; y++)
        for (let x = 0; x < 48; x++)
          if (sim.raster[y * 48 + x] !== 0) nz = true;
      if (!nz) allNonBlank = false;
    }
    ok(allNonBlank, 'every block contains image data (no blank-only block)');
  }
  // 17. Tall-package risk, documented: IF the M02 255-line cap applies to
  //     the M110, a 1000-row package blanks. That cap is unproven for the
  //     M110; split mode is the fallback if hardware ever shows it.
  {
    const bmp = makeBmp(1000, 'random');
    const sim = new SimTransport({maxSegmentRows: 255});
    await T.printJob(bmp, 1000, {transport: sim, ...FAST});
    ok(sim.discarded && sim.rowsReceived === 0, 'tall package under a 255 cap is discarded (known tradeoff)');
  }

  console.log(fails === 0 ? '\nALL ENGINE TESTS PASSED' : '\n' + fails + ' FAILURES');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.log('FATAL:', e); process.exit(1); });
