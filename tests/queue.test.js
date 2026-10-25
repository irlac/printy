// Print Queue tests — run with: node tests/queue.test.js
// Covers the queue pipeline without a printer or network:
// page-selection parsing, shared geometry, banded dither equivalence
// (no seam), banded row rendering, trim scanning, and full queue
// stream assembly (items + spacing, in order, exact row counts).
'use strict';
const T = require('./harness.js').loadApp();
const {SimTransport} = require('./sim-transport.js');

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL:', msg); } else console.log('ok:', msg); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const FAST = {gapMs: 0, chunkBytes: 1024, segmentRows: 128};

function grayGradient(w, h) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x / w) * 255;
  return g;
}

(async () => {
  // 1. parsePages
  {
    ok(JSON.stringify(T.parsePages('', 5)) === '[0,1,2,3,4]', 'pages: empty = all');
    ok(JSON.stringify(T.parsePages('all', 3)) === '[0,1,2]', 'pages: all');
    ok(JSON.stringify(T.parsePages('1,3', 5)) === '[0,2]', 'pages: 1,3');
    ok(JSON.stringify(T.parsePages('2-4', 5)) === '[1,2,3]', 'pages: 2-4');
    ok(JSON.stringify(T.parsePages('3,1-2', 5)) === '[0,1,2]', 'pages: sorted + deduped');
    let threw = false;
    try { T.parsePages('x', 5); } catch (e) { threw = true; }
    ok(threw, 'pages: invalid selection throws');
    threw = false;
    try { T.parsePages('9', 5); } catch (e) { threw = true; }
    ok(threw, 'pages: out-of-range-only throws');
  }
  // 2. queueGeom: scale + trim math
  {
    const g = T.queueGeom(800, 600, null, 100);
    ok(g.dw === 384 && g.dh === 288, 'geom 800x600 @100% -> 384x288 (got ' + g.dw + 'x' + g.dh + ')');
    const g2 = T.queueGeom(800, 600, null, 50);
    ok(g2.dw === 192 && g2.dh === 144, 'geom @50% -> 192x144');
    const g3 = T.queueGeom(800, 600, {x0: 100, y0: 50, w: 400, h: 300}, 100);
    ok(g3.sx === 100 && g3.sy === 50 && g3.sW === 400 && g3.sH === 300 && g3.dh === 288, 'geom honours trim bbox');
  }
  // 3. Banded dither == whole-image dither (no seam), floyd + atkinson.
  for (const mode of ['floyd', 'atkinson']) {
    const W = 384, H = 600;
    const gray = grayGradient(W, H);
    const whole = T.dither(Float32Array.from(gray), W, H, mode);
    const band = T.makeBandDither(mode, W);
    const parts = [];
    for (let y0 = 0; y0 < H; y0 += 256) {
      const bh = Math.min(256, H - y0);
      parts.push(band(gray.slice(y0 * W, (y0 + bh) * W), bh));
    }
    const banded = new Uint8Array(W * H);
    let o = 0;
    for (const p of parts) { banded.set(p, o); o += p.length; }
    ok(eq(banded, whole), 'banded ' + mode + ' == whole-image ' + mode + ' (no seam)');
  }
  // 3b. Edge case: final band of exactly 1 row (257 rows) still matches.
  {
    const W = 384, H = 257;
    const gray = grayGradient(W, H);
    const whole = T.dither(Float32Array.from(gray), W, H, 'floyd');
    const band = T.makeBandDither('floyd', W);
    const b1 = band(gray.slice(0, 256 * W), 256);
    const b2 = band(gray.slice(256 * W), 1);
    const banded = new Uint8Array(W * H);
    banded.set(b1, 0); banded.set(b2, 256 * W);
    ok(eq(banded, whole), 'banded floyd with 1-row final band == whole');
  }
  // 4. renderSourceRows: exact row count, 48-aligned blocks, deterministic.
  {
    const src = T.newCanvas(200, 150);
    const c = src.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(50, 20, 100, 100);
    const geom = T.queueGeom(200, 150, null, 100);
    const opts = {dither: 'floyd', bright: 0, contrast: 0, invert: false};
    const collect = async () => {
      const blocks = [];
      for await (const b of T.renderSourceRows(src, geom, opts)) blocks.push(b);
      return blocks;
    };
    const blocks = await collect();
    let rows = 0;
    for (const b of blocks) { rows += b.length / 48; ok(b.length % 48 === 0, 'render block 48-aligned'); }
    ok(rows === geom.dh, 'render yields exactly geom.dh rows (' + rows + ' vs ' + geom.dh + ')');
    const blocks2 = await collect();
    ok(blocks.length === blocks2.length && blocks.every((b, i) => eq(b, blocks2[i])), 'render is deterministic');
  }
  // 5. scanSourceBbox finds the black rect, ignores white margins.
  {
    const src = T.newCanvas(200, 150);
    const c = src.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, 200, 150);
    c.fillStyle = '#000'; c.fillRect(50, 20, 100, 100);
    const bb = await T.scanSourceBbox(src, 200, 150);
    ok(bb && Math.abs(bb.x0 - 48) <= 3 && Math.abs(bb.y0 - 18) <= 3 &&
       Math.abs(bb.w - 104) <= 6 && Math.abs(bb.h - 104) <= 6,
       'trim bbox ~ (48,18,104,104) (got ' + JSON.stringify(bb) + ')');
    const blank = T.newCanvas(100, 100);
    const bc = blank.getContext('2d');
    bc.fillStyle = '#fff'; bc.fillRect(0, 0, 100, 100);
    ok((await T.scanSourceBbox(blank, 100, 100)) === null, 'trim bbox null on all-white');
  }
  // 6. Full queue stream: 2 images + spacing, exact rows, spacing is zeros,
  //    and the whole thing prints through the segmented engine.
  {
    const fakeFile = (name) => ({name, type: 'image/png'});
    const item1 = {kind: 'image', file: fakeFile('a.png'), scalePct: 100, dither: 'floyd', bright: 0, contrast: 0, invert: false, trim: false, spacingRows: 24};
    const item2 = {kind: 'image', file: fakeFile('b.png'), scalePct: 50, dither: 'threshold', bright: 0, contrast: 0, invert: false, trim: false, spacingRows: 0};
    // harness Image stub is 200x150 for every file
    const g1 = T.queueGeom(200, 150, null, 100); // 384x288
    const g2 = T.queueGeom(200, 150, null, 50);  // 192x144
    const prepared = {items: [
      {item: item1, geom: g1, rows: g1.dh},
      {item: item2, geom: g2, rows: g2.dh},
    ], totalRows: g1.dh + 24 + g2.dh};
    const sim = new SimTransport();
    const r = await T.streamRaster(T.queueRowStream(prepared), prepared.totalRows, {transport: sim, ...FAST});
    ok(r.sentRows === prepared.totalRows, 'queue stream sentRows == total (' + r.sentRows + ' vs ' + prepared.totalRows + ')');
    ok(sim.rowsReceived === prepared.totalRows, 'simulator received all queue rows');
    // spacing block: rows g1.dh .. g1.dh+23 must be all zero
    let spacingZero = true;
    for (let y = g1.dh; y < g1.dh + 24; y++)
      for (let x = 0; x < 48; x++)
        if (sim.raster[y * 48 + x] !== 0) spacingZero = false;
    ok(spacingZero, 'spacing rows are blank (24 rows of zeros between items)');
    // second item actually rendered (not blank)
    let black2 = 0;
    for (let y = g1.dh + 24; y < prepared.totalRows; y++)
      for (let x = 0; x < 48; x++) if (sim.raster[y * 48 + x]) black2++;
    ok(black2 > 0, 'second item rendered content (non-blank)');
    ok(!sim.discarded && sim.footReceived, 'queue job parses clean with foot');
  }
  // 7. Queue kind detection
  {
    ok(T.queueKindFor({name: 'doc.pdf', type: 'application/pdf'}) === 'pdf', 'kind: pdf by name/type');
    ok(T.queueKindFor({name: 'photo.png', type: 'image/png'}) === 'image', 'kind: image');
    ok(T.queueKindFor({name: 'scan.PDF', type: ''}) === 'pdf', 'kind: pdf by extension case-insensitive');
  }

  console.log(fails === 0 ? '\nALL QUEUE TESTS PASSED' : '\n' + fails + ' FAILURES');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.log('FATAL:', e); process.exit(1); });
