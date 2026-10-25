# Printy — Print Engine 2.0

A single-file web app for the Phomemo M110 thermal printer (57 mm
continuous paper, 384-dot / 48 mm print head, Web Bluetooth). Open
`index.html` in a browser with Web Bluetooth (Chrome/Edge desktop or
Android, Bluefy/WebBLE on iPhone), connect the M110, and print.

Tabs: **Studio** (compose text/image/QR/barcode/icon designs),
**Labels** (presets), **Image** (photo dithering + Danbooru),
**Queue** (multi-document print jobs — see below), **Chaos**
(overnight broadcast), **Printer** (connection, tuning, recent prints).

## The Queue tab (new in 2.0)

Stack files into one continuous strip and print them as a single job:

- Formats: PNG, JPEG, WebP, GIF (first frame), BMP, multi-page PDF.
- Add files via picker or drag-and-drop; reorder with ↑/↓, remove with ✕.
- Per item: scale %, dither mode, gap rows after the item, trim-white
  toggle; PDFs also get a page selector (`all`, `1,3`, `2-4`).
- **Prepare** measures every item, renders a dithered half-scale
  preview strip, and reports total rows + estimated time. Each image
  (or PDF page) prints whole as one package, with an automatic line
  break between packages — the printer's own feed lands in the break,
  never inside an image. Packages taller than the Split size (Printer
  tab, default 255 rows) are cut into back-to-back blocks, so tall
  images print instead of blanking. The job then sits in state **Ready** until
  you press **Start printing**.
- **Pause** stops between raster segments (never mid-segment);
  **Resume** continues exactly where it stopped; **Cancel** stops
  cleanly with no footer. After a failed or cancelled attempt, Start
  asks for confirmation before reprinting from the beginning — data
  that may already have printed is never resent automatically.

PDFs load Mozilla's PDF.js 3.11.174 from cdnjs on first use (the only
network dependency in the app; everything else works offline). If it
fails to load, PDF items report an error at Prepare time.

## Tests

```sh
node tests/engine.test.js   # print engine vs simulated M110
node tests/queue.test.js    # queue pipeline (no printer needed)
```

See [docs/PRINT_ENGINE.md](docs/PRINT_ENGINE.md) for the diagnosis of
the blank-output bug, the engine architecture, remaining limitations,
and the full test matrix (simulated vs hardware).
