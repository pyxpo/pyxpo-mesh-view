# pyxpo-mesh-view

Plays a textured 2D mesh animation in [pyxpo](https://github.com/pyxpo/pyxpo) apps: one image, a triangle mesh
over it, and the mesh's vertex positions for every frame. Use it for cut-out and skeletal 2D animation, such as
a drawing that moves. The GPU draws each frame, so it plays smoothly at the screen's rate while Python does
nothing. Android draws with `Canvas.drawVertices`, iOS with Metal, the web and the desktop window with WebGL.

```sh
pip install pyxpo-mesh-view
```

```toml
[tool.pyxpo]
modules = ["mesh-view"]
```

```python
import pyxpo_mesh_view as MeshView
from pyxpo import Button, View, component, use_ref, use_state

# A square of two triangles over the whole image that leans over in one second.
uv = [(0, 0), (1, 0), (1, 1), (0, 1)]
frames = [[(x + 0.2 * k / 30 * y, y) for x, y in uv] for k in range(30)]
open("/path/sway.pxmesh", "wb").write(MeshView.write_mesh(uv, frames, orders=[[0, 1, 2, 0, 2, 3]], fps=30))

@component
def Player():
    player = use_ref(None)
    playing, set_playing = use_state(True)
    return View(
        MeshView.MeshView(ref=player, source="/path/sway.pxmesh", texture="file:///path/picture.png",
                          playing=playing, style={"flex": 1}, on_load=lambda info: print(info)),
        Button(title="Pause" if playing else "Play", on_press=lambda: set_playing(not playing)),
        Button(title="Restart", on_press=lambda: player.current.seek(0)),
        style={"flex": 1},
    )
```

## `MeshView` props

| Prop | Default | |
| --- | --- | --- |
| `source` | `None` | A PXMESH1 file: a path or a `file://` URI. |
| `texture` | `None` | A PNG or JPEG: a path or a `file://` URI. |
| `playing` | `True` | `False` holds the current frame. |
| `loop` | `True` | `False` stops on the last frame and calls `on_end`. |
| `speed` | `1.0` | 0 to 16 times the file's frame rate. |
| `background_color` | `"transparent"` | Any pyxpo color, drawn under the mesh. |
| `on_load` | `None` | Called with `{"frames", "fps", "vertices", "triangles"}` when a file is ready. |
| `on_error` | `None` | Called with `{"message"}` when a file cannot be read. |
| `on_end` | `None` | Called when a clip with `loop=False` reaches its last frame. |
| `style` | | Sizes the view. The animation is fitted inside it and centred (like `resize_mode="contain"`). |

A view reads a file once per path, and the web caches files by URL. To show a new animation, write it to a new
file name.

## `ref.current` methods

- `seek(frame)`: shows `frame` (0-based) and plays on from there if `playing`.

## Functions

- `write_mesh(uv, frames, orders, order_of_frame=None, fps=30)`: PXMESH1 bytes from lists or numpy arrays.
  `uv` is (V, 2), 0 to 1 in the texture with y down. `frames` is (F, V, 2) in any units with y down; they are
  scaled to the box around every frame. `orders` is a list of triangle index lists (back to front), and
  `order_of_frame` says which one each frame draws (default 0). Use more than one order when parts change
  which one is in front, for example an arm that swings from behind the body to in front of it.
- `read_header(data)`: `{"vertices", "frames", "indices", "orders", "fps", "aspect"}` of PXMESH1 bytes. It
  raises `ValueError` for a bad file.

## PXMESH1

A little-endian binary file:

| Field | Type | |
| --- | --- | --- |
| magic | 8 bytes | `PXMESH1\0` |
| V, F, I, O | u32 each | vertices, frames, indices per order (a multiple of 3), orders |
| fps, aspect | f32 each | frame rate, width / height of the box around every frame |
| uv | f32 [V][2] | 0 to 1 in the texture, y down |
| pos | f32 [F][V][2] | 0 to 1 in the box around every frame, y down |
| order_of_frame | u16 [F] | then zero bytes up to a multiple of 4 |
| indices | u16 [O][I] | triangles; pad shorter orders with degenerate triangles `0, 0, 0` |

At most 65536 vertices (u16 indices). A 770-vertex mesh at 30 fps takes about 185 KB per second of animation.
