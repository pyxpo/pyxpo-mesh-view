# Changelog

## 0.1.0a1

- First release: `MeshView` plays a PXMESH1 file (a textured triangle mesh with vertex positions per frame and
  per-frame draw orders) with `playing`, `loop`, `speed`, `seek()` and `on_load`, `on_error`, `on_end`.
  `write_mesh` and `read_header` make and check files. Android (`Canvas.drawVertices`), iOS (Metal), the web
  and the desktop window (WebGL).
