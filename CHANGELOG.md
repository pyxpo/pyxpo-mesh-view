# Changelog

## 0.1.0a1

- Docs: detailed README with screenshots, and fuller PyPI metadata (keywords, classifiers, project URLs).
- First release: `MeshView` plays a PXMESH1 file (a textured triangle mesh with vertex positions per frame and
  per-frame draw orders) with `playing`, `loop`, `speed`, `seek()` and `on_load`, `on_error`, `on_end`.
  `write_mesh` and `read_header` make and check files. Android (`Canvas.drawVertices`), iOS (Metal), the web
  and the desktop window (WebGL).
- `export_async` renders a clip to an MP4 (H.264) or an animated GIF file, with a progress callback, on Android
  (MediaCodec), iOS (AVFoundation, ImageIO), the web and the desktop window (WebCodecs, built-in GIF encoder).
  `export_plan` gives its frame plan.
