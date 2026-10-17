"""Plays a textured 2D mesh animation: one image, a triangle mesh over it, the mesh's vertex positions per frame.

    import pyxpo_mesh_view as MeshView
    from pyxpo import use_ref

    player = use_ref(None)

    MeshView.MeshView(ref=player, source="/path/clip.pxmesh", texture="file:///path/drawing.png",
                      playing=True, loop=True, style={"flex": 1},
                      on_load=lambda info: print(info["frames"], info["fps"]))

    player.current.seek(0)

`source` is a PXMESH1 file (`write_mesh` makes one). The view fits the box around every frame inside itself
(like `resize_mode="contain"`) and plays at the file's frame rate times `speed`. Android draws with
`Canvas.drawVertices`, iOS with Metal, the web and the desktop window with WebGL.

PXMESH1 (little-endian): magic b"PXMESH1\\0"; u32 V, F, I, O; f32 fps, aspect; f32 uv[V][2]; f32 pos[F][V][2];
u16 order_of_frame[F] (padded to 4 bytes); u16 indices[O][I]. `uv` is 0-1 in the texture (y down); `pos` is 0-1
in the box around every frame (y down) and `aspect` is that box's width / height. Each frame draws the `I`
indices (triangles, back to front) of its order. A file can hold several orders so parts change which is in
front; pad shorter orders with degenerate triangles (0, 0, 0).
"""
from __future__ import annotations

import math
import struct
from typing import Any, Callable, Dict, Optional, Sequence
from urllib.parse import unquote, urlparse

from pyxpo import component, use_imperative_handle, use_ref
from pyxpo.module_api import call, native_view, require_linked, view_tag
from pyxpo.style import parse_color

__version__ = "0.1.0a1"

__all__ = ["MeshView", "MeshViewHandle", "write_mesh", "read_header", "MAGIC", "HEADER_SIZE"]

_View = native_view("PxMeshView")

MAGIC = b"PXMESH1\0"
HEADER_SIZE = 32
MAX_VERTICES = 65536     # u16 indices


def _number(name: str, value: Any, low: float, high: float = math.inf) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("%s must be a number, got %r" % (name, value))
    if value < low or value > high:
        raise ValueError("%s must be >= %g%s, got %r" % (name, low, "" if high == math.inf else " and <= %g" % high,
                                                        value))
    return float(value)


def _path(name: str, value: Any) -> str:
    """A plain file path from a path or a file:// URI (what the native side and the web page's fileUrl take)."""
    if not isinstance(value, str) or not value:
        raise ValueError("%s must be a file path or a file:// URI, got %r" % (name, value))
    if value.startswith("file:"):
        u = urlparse(value)
        if u.netloc not in ("", "localhost"):
            raise ValueError("%s must be a local file, got %r" % (name, value))
        return unquote(u.path)
    if "://" in value:
        raise ValueError("%s must be a local file, got %r" % (name, value))
    return value


def read_header(data: bytes) -> Dict[str, Any]:
    """{"vertices", "frames", "indices", "orders", "fps", "aspect"} of PXMESH1 bytes. Checks the size."""
    if len(data) < HEADER_SIZE or data[:8] != MAGIC:
        raise ValueError("not a PXMESH1 file")
    v, f, i, o, fps, aspect = struct.unpack_from("<IIIIff", data, 8)
    if not (0 < v <= MAX_VERTICES and f > 0 and i > 0 and i % 3 == 0 and o > 0):
        raise ValueError("PXMESH1 header has bad counts")
    if not (fps > 0 and aspect > 0 and math.isfinite(fps) and math.isfinite(aspect)):
        raise ValueError("PXMESH1 header has a bad fps or aspect")
    size = HEADER_SIZE + v * 8 + f * v * 8 + f * 2 + (-(f * 2) % 4) + o * i * 2
    if len(data) != size:
        raise ValueError("PXMESH1 is %d bytes, the header says %d" % (len(data), size))
    return {"vertices": v, "frames": f, "indices": i, "orders": o, "fps": fps, "aspect": aspect}


def write_mesh(uv: Sequence[Sequence[float]], frames: Sequence[Sequence[Sequence[float]]],
               orders: Sequence[Sequence[int]], order_of_frame: Optional[Sequence[int]] = None,
               fps: float = 30) -> bytes:
    """PXMESH1 bytes from plain lists (or numpy arrays): `uv` (V, 2) 0-1 in the texture; `frames` (F, V, 2) in any
    units (y down; normalized here to the box around every frame); `orders` (O, I) triangle vertex ids;
    `order_of_frame` (F,) which order each frame draws (default 0). Shorter orders are padded."""
    uv = [(float(a), float(b)) for a, b in uv]
    frames = [[(float(x), float(y)) for x, y in fr] for fr in frames]
    v, f = len(uv), len(frames)
    if not 0 < v <= MAX_VERTICES or not f or any(len(fr) != v for fr in frames):
        raise ValueError("uv and every frame need the same 1-%d vertices" % MAX_VERTICES)
    orders = [[int(k) for k in o] for o in orders]
    if not orders or any(len(o) % 3 or not o for o in orders) or any(not 0 <= k < v for o in orders for k in o):
        raise ValueError("orders must be non-empty triangle lists of vertex ids")
    of = [0] * f if order_of_frame is None else [int(k) for k in order_of_frame]
    if len(of) != f or any(not 0 <= k < len(orders) for k in of):
        raise ValueError("order_of_frame needs one order id per frame")
    xs = [p[0] for fr in frames for p in fr]
    ys = [p[1] for fr in frames for p in fr]
    x0, y0 = min(xs), min(ys)
    w, h = max(max(xs) - x0, 1e-6), max(max(ys) - y0, 1e-6)
    i = max(len(o) for o in orders)
    out = [MAGIC, struct.pack("<IIIIff", v, f, i, len(orders), _number("fps", fps, 1e-3), w / h)]
    out.append(struct.pack("<%df" % (2 * v), *[c for p in uv for c in p]))
    for fr in frames:
        out.append(struct.pack("<%df" % (2 * v), *[c for x, y in fr for c in ((x - x0) / w, (y - y0) / h)]))
    out.append(struct.pack("<%dH" % f, *of) + b"\0" * (-(f * 2) % 4))
    for o in orders:
        out.append(struct.pack("<%dH" % i, *(o + [0] * (i - len(o)))))
    return b"".join(out)


class MeshViewHandle:
    """`ref.current` of a mounted `MeshView`."""

    def __init__(self, view_ref: Any) -> None:
        self._view = view_ref

    def _tag(self) -> int:
        require_linked("MeshView", "mesh-view", package="pyxpo-mesh-view")
        tag = view_tag(self._view)
        if tag is None:
            raise RuntimeError("the MeshView is not mounted")
        return tag

    def seek(self, frame: int) -> None:
        """Shows `frame` (0-based, wraps when `loop`) and plays on from there if `playing`."""
        if isinstance(frame, bool) or not isinstance(frame, int) or frame < 0:
            raise ValueError("frame must be an int >= 0, got %r" % (frame,))
        call("MeshView", "seek", self._tag(), frame)


@component
def MeshView(source: Optional[str] = None, texture: Optional[str] = None, playing: bool = True, loop: bool = True,
             speed: float = 1.0, background_color: Any = "transparent",
             on_load: Optional[Callable[[Dict[str, Any]], Any]] = None,
             on_error: Optional[Callable[[Dict[str, Any]], Any]] = None,
             on_end: Optional[Callable[[Any], Any]] = None, style: Any = None, **props: Any):
    """A mesh animation sized by `style`. `ref.current` is a `MeshViewHandle`.

    `source` is a PXMESH1 file and `texture` a PNG or JPEG (paths or file:// URIs). A file is read once per path:
    write a new file to change the animation. `on_load(info)` gets `{"frames", "fps", "vertices", "triangles"}`;
    `on_error(e)` gets `{"message"}`; `on_end` fires when a clip with `loop=False` reaches its last frame.
    `background_color` defaults to transparent."""
    ref = props.pop("ref", None)
    inner = use_ref(None)
    use_imperative_handle(ref, lambda: MeshViewHandle(inner), [])
    wire: Dict[str, Any] = {
        "source": None if source is None else _path("source", source),
        "texture": None if texture is None else _path("texture", texture),
        "playing": bool(playing), "loop": bool(loop), "speed": _number("speed", speed, 0, 16),
        "background_color": parse_color(background_color),
    }
    for name, fn in (("on_load", on_load), ("on_error", on_error), ("on_end", on_end)):
        if fn is not None:
            wire[name] = fn
    return _View(ref=inner, style=style, **wire, **props)
