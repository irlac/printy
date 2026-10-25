# Print Engine 2.0 — diagnosis, architecture, limitations, tests

> Update (2026-10-24): §2's fixed 128-row segmentation is superseded by
> **package mode** (§5). The M110 feeds ~half an inch after every raster
> block, so cutting an image across blocks shreds it with gaps. Each
> image is now one raster block; automatic line breaks go between
> images only. The 2.0 history below is kept because the blank-output
> diagnosis and the tall-image tradeoff still stand.

## 1. The diagnosed failure

### Symptom

Short images print fine. Excessively large images or documents
sometimes produce **blank output**: the printer's LED flashes, paper
may move, nothing (or nothing intelligible) is printed.

### What the old engine did

One print job was one giant command:

```
1B 4E 0D 05 | 1B 4E 04 <density> | 1F 11 <media>     (init, 11 bytes)
1D 76 30 00 48 00 <height:u16le>                    (raster header)
<48 bytes/row × height>                             (the whole document)
1F F0 05 00 1F F0 03 00                              (footer)
```

The whole document went out as a **single GS v 0 raster block**,
streamed open-loop in 64-byte BLE chunks with fixed 40 ms gaps. There
was no feedback from the printer, no progress beyond a chunk counter,
no way to pause or cancel, and no record of what had printed if
anything failed. A write resolving only meant the OS accepted the
bytes — never that the printer received or printed them.

### Root cause (ranked by evidence)

1. **Unbounded single raster block (the primary cause).** No public
   source verifies the M110 firmware accepts an arbitrarily tall
   single GS v 0 block. The only documented block cap in this printer
   family is **255 lines** (phomemo-tools M02 docs: "a new block
   marker must be sent with the remaining number of line (max is
   255)"); the M110 example in the same docs uses 240 lines. Every
   reference implementation (phomemo-tools, pyphomemo, phomymo) sends
   a single block with the full height — and none of them proves it
   works for very tall images. A tall block exceeds what the firmware
   is proven to absorb, and the observed failure (LED flash, blank
   output) matches the documented whole-job discard behavior.
2. **Pacing violation as the documented discard trigger.** pyphomemo
   documents that merging the command stream without delays makes the
   M110 "flash and discard the job." The old engine did pace its
   chunks, but a minutes-long open-loop stream with no feedback gave
   the firmware no clean block boundaries to recover at — any stall,
   BLE hiccup, or buffer pressure inside one giant block lost the
   whole job instead of one segment.
3. **No completion semantics.** The old engine returned after
   footer + 500 ms regardless of how much paper was still moving.
   For long jobs the UI said "done" minutes before the printer
   finished, inviting disconnects, new jobs, or app backgrounding
   that truncated the tail.
4. **No recovery.** Any mid-stream error aborted the job with no
   record of printed rows; re-running re-risked the same discard.

Secondary host-side factor: the old pipeline held the full document
as a 768 px canvas + full grayscale array + full bitmap (+ a base64
copy in localStorage for recent prints) — unbounded memory growth
with document height.

### What was NOT proven (honesty note)

No public source documents the M110's exact input-buffer size, a
maximum GS v 0 height, or what the firmware does when a limit is
exceeded. The 255-line figure is an M02-family cap, not a measured
M110 limit. The segmentation fix does not depend on knowing the exact
limit: 128-row segments sit safely under every documented cap, and
each segment is small enough for any plausible firmware buffer. The
remaining unknown — whether back-to-back GS v 0 blocks print with
zero gap on the M110 specifically — is flagged as a hardware test
below (it is inferred from M02 docs + generic ESC/POS semantics, not
directly observed on the M110).

### The fix (not a smaller cap)

Documents are still arbitrarily long. Only the **command** is bounded:
the raster is split into row-aligned segments (default 128 rows,
configurable 64/128/255) and each segment is sent as its own GS v 0
command inside one job — one init at the start, one footer at the
end, no re-init and no footer between segments. A 10,000-row document
is 79 segments, not a smaller document.

## 2. Architecture

### Three levels, three limits

| Level | Unit | Limit | Notes |
|---|---|---|---|
| **Job** | one physical printout | none (arbitrary rows) | one init + one footer |
| **Segment** | one GS v 0 command | `segmentRows` (default 128) | printer absorbs one at a time |
| **Chunk** | one BLE GATT write | `chunkBytes` (default 64 B) | pure transport packetization |

The printer never sees chunk boundaries; the host never sends a
segment larger than configured. Progress is reported in **rows**,
not chunks.

### Byte layout (unchanged from 1.0 — small jobs are byte-identical)

```
job head:  1B 4E 0D 05  1B 4E 04 <density>  1F 11 <media>
segment:   1D 76 30 00  48 00  <rows:u16le>  <48 bytes/row × rows>
footer:    1F F0 05 00  1F F0 03 00
```

Pacing (matches reference implementations): 30 ms after each init
part and after each segment header; `chunkBytes`/`chunkDelay` between
BLE chunks inside a segment; 300 ms before the footer, 500 ms after.
For jobs of ≤ `segmentRows` rows, Engine 2.0 emits byte-for-byte the
same stream as Engine 1.0 (proven by test).

### State machine

```
idle -> preparing -> ready -> printing -> paused <-> printing
                                      -> completed / failed / cancelled
```

- Direct prints (Studio / Image / Danbooru / Chaos / Reprint) go
  `preparing -> printing`; the click is the confirmation.
- Queue prints go `preparing -> ready` (preview + row count shown)
  and wait for **Start printing**.
- **Pause** is honoured only between segments, never mid-segment: a
  printer left waiting mid-raster may time out and discard the block.
- **Cancel** stops at the next chunk/segment boundary, sends no
  footer, and reports rows sent.
- **Failed** stops immediately, sends no footer, and reports rows
  sent plus the error. Nothing is ever resent automatically; after a
  failed or cancelled attempt, Start asks for confirmation before
  reprinting from row 0 (see "no blind resends" below).
- A BLE disconnect during printing moves the job to **failed** via
  both the disconnect event and the next failed write.

### No blind resends

The engine tracks `sentRows` (rows whose writes resolved). On failure
or cancellation it stops and reports that number. It never retries a
segment on its own, because a resolved write may already have
printed. Reprinting is always a fresh job from row 0, started by the
user, with an explicit confirmation when a previous attempt may have
printed part of the job.

### Queue rendering pipeline (bounded memory)

1. **Prepare** loads each file's metadata only (image dimensions,
   PDF page count/sizes) and computes a per-item geometry
   `{sx, sy, sW, sH, dw, dh}` — source rect + 384-wide display size.
   Trim-white (optional) scans the source in bands for the non-white
   bounding box. Prepare and print share this geometry, so the row
   count promised at Prepare is exactly the row count printed.
2. **Print** streams items in order through `streamRaster`:
   each item renders in **256-row bands** (draw band → grayscale →
   levels → dither → pack → yield). Only one band is in memory at a
   time; the whole queue is never materialized as one bitmap.
3. **Dithering across bands** carries Floyd–Steinberg / Atkinson
   error over band boundaries (a 2-row carry buffer), so band seams
   are invisible — verified byte-identical against whole-image
   dithering, including the 1-row final-band edge case.
   Threshold and ordered (Bayer) dithering are per-pixel and need no
   carry.
4. **Spacing** is blank rows (zeros) between documents, not after
   the last one.
5. **GIF** uses `ImageDecoder` frame 0 when available (true first
   frame), falling back to `<img>`. **BMP** decodes via `<img>` in
   all modern browsers. **PDF** renders each selected page with
   PDF.js 3.11.174 (cdnjs, lazy-loaded); the page bytes are sliced
   per document because pdf.js may neuter the buffer it is given.

### Transports

The engine talks to a transport interface
`{connected: boolean, write(Uint8Array): Promise}`. The real one
wraps the Web Bluetooth characteristic (write-without-response
preferred, with-response fallback, same as before). Tests substitute
`tests/sim-transport.js`, a streaming parser that reconstructs the
printed raster and models the firmware discard of oversized segments.

## 3. Protocol limitations that remain

- **M110 segment ceiling is unproven.** 128 rows is conservative and
  under the 255-line family cap, but the true M110 limit was not
  found in any public source. If 255-row segments ever blank on
  hardware, drop to 128 or 64 (Printer tab → segment).
- **Back-to-back segment seam is inferred, not observed on M110.**
  M02 docs + ESC/POS semantics say consecutive raster commands print
  with no gap and no feed; no public M110 log demonstrates it.
  Hardware test #2 below checks the seam.
- **No printer-side flow control exists in this protocol.** There is
  no status gate, XON/XOFF, or print-complete notification in the
  standard flow; pacing + small segments are the flow control.
  "Completed" means all bytes were sent + footer + 500 ms settle —
  the printer may still be feeding the last rows.
- **Gapped-label media (0x0A)** auto-feeds to the next gap; segment
  concatenation without gaps is only promised for continuous media
  (0x0B), the default. Do not re-select media between segments.
- **Dense black / thermal power:** no M110-specific limit was found
  (the manual only lists solid-red LED = overheated). Dense-black
  output is a hardware/thermal matter, not a protocol one; density
  10 is the default, 15 is darkest.
- **The footer pair's individual semantics are not publicly decoded.**
  It is sent once, at the end, in the documented order — never
  between segments. Do not assign the two halves meanings like
  "feed" or "cut".
- **PDF needs network once** (PDF.js from cdnjs). Everything else
  works offline. PDF rendering fidelity depends on pdf.js, not on
  the print engine.

## 4. Test results

### Simulated tests (all pass, no printer needed)

```sh
node tests/engine.test.js   # 27 assertions
node tests/queue.test.js    # 26 assertions
node /tmp/studiotest-printy.js  # original app suite, 69 checks (re-pointed at index.html)
```

| # | Task matrix case | Result (simulated) |
|---|---|---|
| 1 | Short image that already prints | ✅ Byte-identical to legacy encoder; 1 segment; parses clean |
| 2 | Long image that previously blanked | ✅ Legacy 1000-row single block **discarded (blank)** by the simulator under a 255-row cap; segmented engine prints all 1000 rows **byte-exact** |
| 3 | Multiple consecutive images | ✅ Queue stream (2 images + 24 blank spacing rows) concatenates in order, exact row counts |
| 4 | Multi-page PDF | ⚠️ Logic tested (page parsing, per-page geometry); full PDF render needs pdf.js + a real PDF — see hardware checklist |
| 5 | Mixed image/PDF queue | ⚠️ Same code path as #3 + #4; end-to-end mixed run is a hardware checklist item |
| 6 | Bluetooth disconnection mid-print | ✅ Engine throws, state `failed`, no footer sent, `sentRows` < total, nothing resent |
| 7 | Dense black image | ✅ 512 solid-black rows reconstruct byte-exact |
| — | Segmentation shape | ✅ 300 rows → 128/128/44; one head, one foot, nothing between |
| — | Pause/resume | ✅ State observed as `paused`; resume prints all rows exactly once |
| — | Cancel | ✅ Stops at a segment boundary (128 rows), no footer, state `cancelled` |
| — | Row alignment | ✅ 257 random rows land at their own offsets (no off-by-one at seams) |
| — | Banded dither | ✅ Floyd + Atkinson banded == whole-image, including 1-row final band |
| — | Empty job | ✅ Refused before sending anything |
| — | Back-to-back jobs | ✅ Second job re-inits cleanly after the first |
| — | Original app suite | ✅ 69/69 checks pass (Studio, Labels, Image Lab, Danbooru, Chaos) |

### Hardware tests (NOT yet run — this VM has no Bluetooth radio)

Run these on the M110 from the deployed site and report back; they are
the only results that can confirm the inferred behaviors:

1. **Short control:** print the test pattern (Printer tab). Must match
   1.0 behavior exactly.
2. **Segment seam:** print a 300-row tall image (e.g., a vertical
   gradient + a ruler). Check the 128-row seams for a blank line, a
   duplicated line, or a shift. Expected: invisible.
3. **Long image:** print an image that blanked under 1.0 (tall photo
   or long receipt, 1000+ rows). Expected: full print, no blank.
4. **Queue:** 3 images + 1 multi-page PDF, with spacing. Expected:
   one continuous strip, spacing rows blank, no feeds between items.
5. **Disconnect:** pull the printer's power (or walk out of range)
   mid-print of a long job. Expected: job reports `failed` with rows
   sent; reconnecting and pressing Start asks for confirmation (no
   auto-resend).
6. **Dense black:** full-black 500-row block at density 10, then 15.
   Watch for fading (thermal/power) vs protocol failure — fading with
   complete rows is hardware, blank is protocol.
7. **Segment size sweep (optional):** repeat #3 at 255-row segments;
   if it blanks, the M110 ceiling is below 255 — stay at 128.

## 5. Package mode — the feed-after-block correction (2026-10-24)

### The finding

Hardware testing of Engine 2.0 showed a behavior no public source
documents: **when a raster block stops printing, the M110 spools
about half an inch** (~100 rows at 8 dots/mm). Under 2.0's fixed
segmentation, a block boundary falls every 128 rows with no regard
for image boundaries, and queue segments routinely straddle two
images. The spool therefore lands *inside* images every 128 rows,
shredding them into strips separated by blank gaps. The queue made
it worse, not better: the strip was continuous in bytes but broken
on paper.

This is an observed hardware behavior, not a documented protocol
fact. The search for a public source (manuals, phomemo-tools,
pyphomemo, phomymo) found nothing about mid-job auto-feed on
continuous media — the manuals only mention feed-on-load calibration
for gap paper. The mechanism is inferred from the observation plus
the code: the only within-image boundaries the engine creates are
raster-block boundaries, so the feed must follow block ends.

### The design

- **A package is one image.** Every image (and every PDF page, which
  is an image) goes out as exactly one GS v 0 block, regardless of
  height. Row streams mark package ends with a `PKG_END` marker; the
  engine flushes only on markers (or end of stream), never on a row
  count.
- **Automatic line breaks go between packages.** The queue inserts a
  break (default 24 blank rows, adjustable in the Queue tab) between
  consecutive packages, plus any per-item spacing. Break and spacing
  rows are yielded *after* the package-end marker, so they belong to
  the *next* package's block: no blank-only block is ever sent (which
  would waste a feed on nothing), and the printer's post-block feed
  lands in the break zone, never inside image data.
- **Splitting is opt-in, not default.** The Printer tab's old
  segment-size control is now "Split": `never` (default), 255, 128,
  or 64 rows. It only cuts packages taller than the chosen size, as
  a fallback for very tall images. The setting key changed, so the
  old 128-row default does not carry over — everyone gets `never`
  unless they choose otherwise.
- **Direct prints are packages too.** Studio, Image Lab, Danbooru,
  Chaos pieces and reprints each send their bitmap as one block.
  Chaos pieces were already separate jobs, so each already had its
  own feed as separation; nothing changes for them except tall
  pieces no longer split.

### The tradeoff, stated plainly

Package mode and the original blank-output problem pull in opposite
directions, and both caps are unproven for the M110:

- If the M02 255-line cap *does* apply to the M110, a package taller
  than 255 rows may print blank — the exact failure 2.0 was built to
  avoid. That is now the known risk of the default.
- If it does *not* apply, packages print whole at any height and
  2.0's segmentation was pure cost.

The honest resolution is a hardware test, not a theory: print a tall
image (500+ rows) as one package. If it prints whole, the cap does
not bind and package mode is strictly better. If it blanks, the cap
is real, and the right rule becomes "package, unless taller than the
proven cap, then split" — with splitting's gaps accepted only for
those images. Until that test runs, `never` is the default because
shredding is observed and blanking-on-tall-block is not (for the
M110 specifically).

### Pause granularity change

Pause is still honoured only between blocks, never mid-block (a
printer left waiting mid-raster may time out and discard the block).
Under package mode a block is a whole image, so pausing during a
large package waits until that package finishes *sending* (at the
standard pacing, roughly 30 rows/second — a 500-row package takes
~15 s to send). The status line now reports the block count without
a total, since the block total is not known until the stream ends.

### Package-mode test results (simulated, all pass)

The simulator gained the observed behavior: after every block it
inserts `feedRows` blank rows (default 100, the observed half inch)
and records each feed's row offset, so tests prove where feeds land:

| Case | Result |
|---|---|
| Bug reproduction: 300-row image cut at 128 | Feeds at rows 128, 356, 500 — the first feed lands inside the image span (0–299) and rows 128–227 of the output are feed blank, not image data. The reported shredding, reproduced. |
| Fix: 2 images + 24-row break as packages | Blocks [100, break+img2 224]; feeds at 100 and 424 — package boundaries only; no feed overlaps any image data range; data minus feeds is byte-exact. |
| Tall image as one package (1000 rows) | Exactly 1 block, byte-exact (uncapped simulator). |
| Split-mode tradeoff (300 rows, split at 128) | First feed inside the image span — splitting shreds, as documented. |
| No blank-only block | Every block contains image data; breaks ride with the following package. |
| Tall package under a 255 cap | Discarded (blank) — the known tradeoff, documented, not hidden. |
| Full queue stream (2 images, break + spacing) | Blocks [288, 192]; feeds at 288 and 580; break + spacing blank; second image non-blank; foot received. |
| Original app suite (Studio, Labels, Image, Danbooru, Chaos) | 69/69 checks pass against the new code. |

### Hardware tests still needed (updated)

1. **The tall-package test (decisive):** print a 500+ row image as
   one package. Whole = the cap does not bind, package mode wins.
   Blank = the cap is real, and splitting returns for tall images.
2. **Package seam:** print a 2-image queue. Expected: each image
   whole, one clean break between them (spool + break rows), no
   gaps inside either image.
3. **Break size:** tune the Queue tab's break value to taste — the
   spool already separates packages, so the break rows are just a
   top-up, not the whole separation.
4. **Pause during a large package:** confirm the pause lands after
   the package finishes sending, with no lost or duplicated rows.
5. **Split fallback (only if test 1 blanks):** repeat test 1 with
   Split at 255, then 128, and note which size prints whole.

### A note on the one test bug found

While validating, the queue trim test initially failed — not in app
code, but in the test harness itself: the copied canvas stub's
`fillRect` loop started at (0,0) instead of (x0,y0), so every test
rectangle bled to the origin. Fixed in `tests/harness.js`; all suites
pass after the fix. The app code was never implicated.
