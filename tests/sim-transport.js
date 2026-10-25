// SimTransport — a fake M110 for automated testing (Node, no DOM, no BLE).
// It parses the byte stream exactly like the printer firmware would:
//   job head (11 bytes) -> repeated raster segments (8-byte GS v 0 header
//   + 48*rows data) -> footer (8 bytes).
// It models the one firmware behavior that matters for Printy 2.0:
// if a single segment declares MORE than maxSegmentRows rows, the whole
// job is DISCARDED (blank output) — the failure mode of the old engine,
// which sent every document as one giant segment. The limit is NOT
// documented for the M110 (the only documented family cap is 255 lines
// for the M02); the simulator makes the assumption explicit and
// configurable so tests can prove segmentation fixes it.
'use strict';

class SimTransport {
  constructor({maxSegmentRows = 255, failAfterBytes = Infinity} = {}) {
    this.connected = true;
    this.maxSegmentRows = maxSegmentRows;
    this.failAfterBytes = failAfterBytes;
    this.bytesReceived = 0;
    this.writes = [];          // raw writes, in order
    this.raster = new Uint8Array(0); // reconstructed printed rows (48 B each)
    this.segments = [];        // {rows} per accepted segment
    this.headReceived = false;
    this.footReceived = false;
    this.discarded = false;    // true once the firmware gave up on the job
    this.parseError = null;
    this._buf = new Uint8Array(0);
    this._state = 'head';      // head -> header -> data -> header ... -> foot
    this._pendingRows = 0;
  }

  async write(bytes) {
    if (!this.connected) throw new Error('simulated disconnect');
    if (this.bytesReceived + bytes.length > this.failAfterBytes) {
      this.connected = false;
      throw new Error('simulated disconnect');
    }
    this.bytesReceived += bytes.length;
    this.writes.push(bytes);
    if (this.discarded || this._state === 'done') return; // printer ignores the rest
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
            // Firmware gives up on the whole job: blank output.
            this.discarded = true;
            this.raster = new Uint8Array(0);
            this.segments = [];
            this._state = 'discarded';
            return;
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
        const nb = new Uint8Array(this.raster.length + data.length);
        nb.set(this.raster); nb.set(data, this.raster.length); this.raster = nb;
        this.segments.push({rows: this._pendingRows});
        this._state = 'header';
      } else {
        return; // done / discarded
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
