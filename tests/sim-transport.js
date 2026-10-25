// SimTransport — a fake M110 for automated testing (Node, no DOM, no BLE).
// It parses the byte stream exactly like the printer firmware would:
//   job head (11 bytes) -> repeated raster blocks (8-byte GS v 0 header
//   + 48*rows data) -> footer (8 bytes).
// It models two firmware behaviors that matter for Printy:
// 1. Discard-over-cap: if a single block declares MORE than
//    maxSegmentRows rows, THAT BLOCK is discarded (blank) and the
//    job CONTINUES with the next block — observed on real hardware
//    2026-10-24 (3-package queue: oversize first package blank, the
//    other two printed). The limit is NOT documented for the M110
//    (the only documented family cap is 255 lines for the M02); the
//    simulator makes the assumption explicit and configurable.
//    A discarded block contributes no rows and no feed: the model
//    assumes nothing printed means nothing to present.
// 2. Feed-after-block (observed on real M110 hardware, 2026-10-24, NOT
//    in any public doc): after every raster block the printer spools
//    feedRows blank rows (~half an inch, ~100 rows at 8 dots/mm).
//    Feeds are recorded with their reconstructed row offsets, so tests
//    can prove a feed lands between images and never inside one.
'use strict';

class SimTransport {
  constructor({maxSegmentRows = 255, feedRows = 0, failAfterBytes = Infinity} = {}) {
    this.connected = true;
    this.maxSegmentRows = maxSegmentRows;
    this.feedRows = feedRows;
    this.failAfterBytes = failAfterBytes;
    this.bytesReceived = 0;
    this.writes = [];          // raw writes, in order
    this.raster = new Uint8Array(0); // reconstructed output (48 B/row), feeds included
    this.segments = [];        // {rows, at} per accepted block, {rows, blank:true, at:null} per discarded block
    this.feeds = [];           // {at, rows} per post-block feed (reconstructed row offsets)
    this.headReceived = false;
    this.footReceived = false;
    this.discarded = false;    // true once any block was discarded (blanked)
    this.parseError = null;
    this._buf = new Uint8Array(0);
    this._state = 'head';      // head -> header -> data -> header ... -> foot
    this._pendingRows = 0;
    this._skipData = false;    // true while consuming a discarded block's bytes
  }

  async write(bytes) {
    if (!this.connected) throw new Error('simulated disconnect');
    if (this.bytesReceived + bytes.length > this.failAfterBytes) {
      this.connected = false;
      throw new Error('simulated disconnect');
    }
    this.bytesReceived += bytes.length;
    this.writes.push(bytes);
    if (this._state === 'done') return; // printer ignores the rest
    const nb = new Uint8Array(this._buf.length + bytes.length);
    nb.set(this._buf); nb.set(bytes, this._buf.length); this._buf = nb;
    this._parse();
  }

  _take(n) {
    const out = this._buf.slice(0, n);
    this._buf = this._buf.slice(n);
    return out;
  }

  _parse() {
    for (;;) {
      if (this._state === 'head') {
        if (this._buf.length < 11) return;
        const h = this._take(11);
        const ok = h[0] === 0x1b && h[1] === 0x4e && h[2] === 0x0d &&
                   h[4] === 0x1b && h[5] === 0x4e && h[6] === 0x04 &&
                   h[8] === 0x1f && h[9] === 0x11;
        if (!ok) { this.parseError = 'bad job head'; this._state = 'done'; return; }
        this.headReceived = true;
        this._state = 'header';
      } else if (this._state === 'header') {
        if (this._buf.length < 8) return;
        const h = this._buf.slice(0, 8);
        if (h[0] === 0x1f && h[1] === 0xf0 && h[2] === 0x05 && h[3] === 0x00 &&
            h[4] === 0x1f && h[5] === 0xf0 && h[6] === 0x03 && h[7] === 0x00) {
          this._take(8);
          this.footReceived = true;
          this._state = 'done';
          return;
        }
        if (h[0] === 0x1d && h[1] === 0x76 && h[2] === 0x30 && h[3] === 0x00 &&
            h[4] === 48 && h[5] === 0) {
          this._take(8);
          this._pendingRows = h[6] | (h[7] << 8);
          if (this._pendingRows <= 0) { this.parseError = 'zero-row segment'; this._state = 'done'; return; }
          if (this._pendingRows > this.maxSegmentRows) {
            // Oversize block: blank THIS block, consume its bytes,
            // keep parsing — the job continues (observed 2026-10-24).
            this.discarded = true;
            this.segments.push({rows: this._pendingRows, blank: true, at: null});
            this._skipData = true;
            this._state = 'data';
            continue;
          }
          this._state = 'data';
        } else {
          this.parseError = 'bad segment header: ' + [...h].map(b => b.toString(16).padStart(2, '0')).join(' ');
          this._state = 'done';
          return;
        }
      } else if (this._state === 'data') {
        const need = this._pendingRows * 48;
        if (this._buf.length < need) return;
        const data = this._take(need);
        if (this._skipData) { this._skipData = false; this._state = 'header'; continue; }
        const at = this.raster.length / 48;
        const nb = new Uint8Array(this.raster.length + data.length);
        nb.set(this.raster); nb.set(data, this.raster.length); this.raster = nb;
        this.segments.push({rows: this._pendingRows, at});
        if (this.feedRows > 0) {
          const feedAt = this.raster.length / 48;
          const fb = new Uint8Array(this.raster.length + this.feedRows * 48);
          fb.set(this.raster); // rest stays zero = blank feed rows
          this.raster = fb;
          this.feeds.push({at: feedAt, rows: this.feedRows});
        }
        this._state = 'header';
      } else {
        return; // done
      }
    }
  }

  get rowsReceived() { return this.raster.length / 48; }
  get allBytes() {
    const out = new Uint8Array(this.bytesReceived);
    let o = 0;
    for (const w of this.writes) { out.set(w, o); o += w.length; }
    return out;
  }
}

module.exports = {SimTransport};
