"""pyxpo-mesh-view: props on the wire, events, seek over a fake bridge, the PXMESH1 writer and the web build."""
import json
import shutil
import struct
import subprocess

import pytest

from pyxpo import LocalChannel, component, create_app, use_ref
from pyxpo.app import App
from pyxpo.build import web
from pyxpo.module_testing import FakeBridge
from pyxpo.renderers.mock import MockRenderer
from pyxpo.renderers.web import page_js

import pyxpo_mesh_view as MV

UV = [(0, 0), (1, 0), (1, 1), (0, 1)]
ORDERS = [[0, 1, 2, 0, 2, 3]]


def mount(root, **props):
    ch = LocalChannel()
    r = MockRenderer(ch)
    app = create_app(root, ch, **props)
    return app, r


def test_props_on_the_wire_and_events():
    got = []

    @component
    def Root():
        return MV.MeshView(source="/c/a.pxmesh", texture="file:///c/my%20drawing.png", speed=2, loop=False,
                           background_color="#fff", on_load=got.append, on_error=got.append,
                           on_end=lambda e: got.append("end"), style={"flex": 1})

    app, r = mount(Root)
    (node,) = r.find_all("PxMeshView")
    p = node.props
    assert p["source"] == "/c/a.pxmesh" and p["texture"] == "/c/my drawing.png"
    assert p["playing"] is True and p["loop"] is False and p["speed"] == 2.0 and p["background_color"] == 0xFFFFFFFF
    assert p["on_load"] is True and p["on_error"] is True and p["on_end"] is True
    info = {"frames": 30, "fps": 30.0, "vertices": 4, "triangles": 2}
    r.emit("load", node, {"value": info})
    r.emit("error", node, {"value": {"message": "bad"}})
    r.emit("end", node, {"value": None})
    assert got == [info, {"message": "bad"}, "end"]


def test_defaults():
    @component
    def Root():
        return MV.MeshView()

    app, r = mount(Root)
    (node,) = r.find_all("PxMeshView")
    p = node.props
    assert p["source"] is None and p["texture"] is None and p["background_color"] == 0
    assert p["playing"] is True and p["loop"] is True and p["speed"] == 1.0
    assert not {"on_load", "on_error", "on_end"} & set(p)


@pytest.mark.parametrize("kw", [{"speed": -1}, {"speed": 17}, {"speed": True}, {"speed": float("nan")},
                                {"source": "https://x/a.pxmesh"}, {"texture": "file://host/a.png"}, {"source": ""}])
def test_bad_props(kw):
    @component
    def Root():
        return MV.MeshView(**kw)

    app = App(Root, LocalChannel(), None)
    app.on_error = lambda e: (_ for _ in ()).throw(e)
    with pytest.raises(ValueError):
        app.start()


def _handle():
    refs = []

    @component
    def Root():
        ref = use_ref(None)
        refs.append(ref)
        return MV.MeshView(ref=ref)

    app, r = mount(Root)
    return refs[-1], r.find_all("PxMeshView")[0].id


def test_seek():
    ref, tag = _handle()
    with FakeBridge("ios"):
        with pytest.raises(Exception, match="pyxpo-mesh-view"):
            ref.current.seek(0)
    with FakeBridge("android") as fb:
        fb.on("MeshView", "seek", lambda t, f: None)
        assert isinstance(ref.current, MV.MeshViewHandle)
        ref.current.seek(12)
        assert fb.calls[-1][:3] == ("MeshView", "seek", (tag, 12))
        for bad in (-1, 1.5, True):
            with pytest.raises(ValueError):
                ref.current.seek(bad)


def test_write_mesh_layout():
    frames = [[(10 + x * 20 + k, 5 + y * 40) for x, y in UV] for k in range(3)]   # 3 frames, x moves by 1
    data = MV.write_mesh(UV, frames, ORDERS + [[0, 2, 3]], order_of_frame=[0, 1, 0], fps=24)
    head = MV.read_header(data)
    assert head == {"vertices": 4, "frames": 3, "indices": 6, "orders": 2, "fps": 24.0,
                    "aspect": pytest.approx(22 / 40)}
    at = MV.HEADER_SIZE
    assert struct.unpack_from("<8f", data, at) == (0, 0, 1, 0, 1, 1, 0, 1)
    at += 4 * 8
    first = struct.unpack_from("<8f", data, at)
    assert first == pytest.approx((0, 0, 20 / 22, 0, 20 / 22, 1, 0, 1))      # box: x 10-32, y 5-45
    at += 3 * 4 * 8
    assert struct.unpack_from("<3H", data, at) == (0, 1, 0)
    at += 8                                          # 6 bytes, padded to 8
    assert struct.unpack_from("<12H", data, at) == (0, 1, 2, 0, 2, 3, 0, 2, 3, 0, 0, 0)
    assert at + 24 == len(data)


@pytest.mark.parametrize("args", [
    ([], [[]], ORDERS), (UV, [UV[:3]], ORDERS), (UV, [UV], []), (UV, [UV], [[0, 1]]), (UV, [UV], [[0, 1, 4]]),
])
def test_write_mesh_validates(args):
    with pytest.raises(ValueError):
        MV.write_mesh(*args)
    with pytest.raises(ValueError):
        MV.write_mesh(UV, [UV], ORDERS, order_of_frame=[1])


def test_read_header_checks():
    good = MV.write_mesh(UV, [UV, UV], ORDERS)
    assert MV.read_header(good)["frames"] == 2
    for bad in (b"", b"NOTAMESH" + good[8:], good[:-2], good + b"\0\0",
                good[:8] + struct.pack("<I", 0) + good[12:], good[:24] + struct.pack("<f", 0) + good[28:]):
        with pytest.raises(ValueError):
            MV.read_header(bad)


def test_numpy_input():
    np = pytest.importorskip("numpy")
    uv = np.array(UV, dtype=np.float32)
    frames = np.stack([uv * 3, uv * 3 + 1])
    assert MV.write_mesh(uv, frames, np.array(ORDERS, dtype=np.uint16)) == MV.write_mesh(UV, frames.tolist(), ORDERS)


def test_page_js_and_web_build(tmp_path):
    assert set(page_js({"MeshView": "pyxpo_mesh_view"})) == {"MeshView"}
    p = tmp_path / "proj"
    (p / "app").mkdir(parents=True)
    (p / "app" / "index.py").write_text("print('hi')\n")
    (p / "pyproject.toml").write_text('[project]\nname="x"\nversion="1.0.0"\n[tool.pyxpo]\nname = "Demo"\n'
                                      'bundle_id = "com.acme.demo"\nmodules = ["mesh-view"]\n')
    out = web.build(p)
    html = (out / "index.html").read_text(encoding="utf-8")
    cfg = json.loads(html.split("window.PYXPO_CONFIG = ", 1)[1].split(";</script>", 1)[0])
    assert cfg["scripts"] == ["modules/MeshView.js"]
    assert (out / "modules" / "MeshView.js").read_text() == open(MV.__path__[0] + "/web.js").read()


NODE_PARSE = r"""
const fs = require("fs");
let view, mod;
global.pyxpoPage = { defineView(t, f) { view = f; }, defineModule(n, f) { mod = f; } };
eval(fs.readFileSync(process.argv[2], "utf8"));
const parse = view.parse;
const b = fs.readFileSync(process.argv[3]);
const m = parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
console.log(JSON.stringify({v: m.vertices, f: m.frames, n: m.indexCount, fps: m.fps, of: Array.from(m.orderOfFrame),
  idx: Array.from(m.indices), pos1: Array.from(m.pos.slice(8, 10))}));
try { parse(new ArrayBuffer(40)); } catch (e) { console.log(e.message); }
"""


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_web_js_parses_files(tmp_path):
    subprocess.run(["node", "--check", MV.__path__[0] + "/web.js"], check=True)
    f = tmp_path / "a.pxmesh"
    f.write_bytes(MV.write_mesh(UV, [UV, [(x + 1, y) for x, y in UV], UV], ORDERS + [[3, 2, 0]], [0, 1, 1], fps=12))
    (tmp_path / "t.js").write_text(NODE_PARSE)
    out = subprocess.run(["node", str(tmp_path / "t.js"), MV.__path__[0] + "/web.js", str(f)], check=True,
                         capture_output=True, text=True).stdout.splitlines()
    got = json.loads(out[0])
    assert got == {"v": 4, "f": 3, "n": 6, "fps": 12, "of": [0, 1, 1], "idx": [0, 1, 2, 0, 2, 3, 3, 2, 0, 0, 0, 0],
                   "pos1": [0.5, 0]}
    assert out[1] == "not a PXMESH1 file"


def _clip(tmp_path, frames=48, fps=24.0):
    src = tmp_path / "clip.pxmesh"
    src.write_bytes(MV.write_mesh(UV, [[(x * 2, y) for x, y in UV]] * frames, ORDERS, fps=fps))   # aspect 2
    tex = tmp_path / "tex.png"
    tex.write_bytes(b"png")
    return str(src), str(tex)


def test_export_plan():
    h = {"frames": 48, "fps": 24.0, "aspect": 2.0}
    p = MV.export_plan(h, "mp4")
    assert (p["width"], p["height"], p["fps"]) == (720, 352, 24.0)
    assert p["frames"] == list(range(48))
    x, y, w, hh = p["rect"]
    assert w / hh == pytest.approx(2.0) and x >= 36 - 1e-6 and y >= 36 - 1e-6
    assert x + w <= 720 - 36 + 1e-6 and y + hh <= 352 - 36 + 1e-6
    g = MV.export_plan(h, "gif")
    assert (g["width"], g["height"], g["fps"]) == (480, 240, 12.0)
    assert g["frames"] == list(range(0, 48, 2))
    sq = MV.export_plan(h, "mp4", size=512, aspect=1, padding=0, fps=30, loops=2)
    assert (sq["width"], sq["height"]) == (512, 512)
    assert sq["rect"] == [0, 128, 512, 256]
    assert len(sq["frames"]) == 120 and max(sq["frames"]) == 47 and sq["frames"][:60] == sq["frames"][60:]
    tall = MV.export_plan({"frames": 10, "fps": 10.0, "aspect": 0.5}, "mp4", size=100)
    assert (tall["width"], tall["height"]) == (48, 96) and all(v % 16 == 0 for v in (48, 96))
    for kw in ({"size": 31}, {"size": 4096}, {"size": True}, {"padding": 0.5}, {"fps": 0}, {"loops": 0},
               {"aspect": 0}):
        with pytest.raises(ValueError):
            MV.export_plan(h, "mp4", **kw)
    with pytest.raises(ValueError, match="format"):
        MV.export_plan(h, "webm")


def test_export_async_native(tmp_path):
    import asyncio
    from pyxpo.modules import dispatch
    src, tex = _clip(tmp_path)
    out = tmp_path / "dance.mp4"
    seen = []

    def export(o):
        dispatch({"name": "MeshView.progress", "data": {"id": o["id"], "progress": 0.5}})
        dispatch({"name": "MeshView.progress", "data": {"id": o["id"] + 1000, "progress": 0.9}})   # another export
        out.write_bytes(b"mp4")
        return None

    with FakeBridge("ios", modules=("MeshView",)) as fb:
        fb.on("MeshView", "export", export)
        res = asyncio.run(MV.export_async(src, tex, str(out), size=320, background_color="#33669980",
                                          on_progress=seen.append))
        (o,) = fb.calls[-1][2]
    assert seen == [0.5]
    assert res == {"path": str(out), "format": "mp4", "width": 320, "height": 160, "frames": 48, "fps": 24.0,
                   "duration": 2.0}
    assert o["background_color"] == 0xFF336699 and o["format"] == "mp4" and o["source"] == src
    assert o["path"] == str(out) and o["texture"] == tex and len(o["frames"]) == 48
    assert MV._progress == {}


def test_export_async_page_sends_bytes(tmp_path):
    import asyncio
    src, tex = _clip(tmp_path)
    out = tmp_path / "dance.gif"
    with FakeBridge("web", modules=("MeshView",)) as fb:
        fb.on("MeshView", "export", lambda o: {"data": "R0lGODlh"})
        res = asyncio.run(MV.export_async("file://" + src, tex, str(out), loops=2))
    assert out.read_bytes() == b"GIF89a"
    assert (res["format"], res["width"], res["height"], res["frames"], res["fps"]) == ("gif", 480, 240, 48, 12.0)


def test_export_async_checks(tmp_path):
    import asyncio
    src, tex = _clip(tmp_path)
    with FakeBridge("android", modules=("MeshView",)) as fb:
        fb.on("MeshView", "export", lambda o: None)
        with pytest.raises(ValueError, match="format"):
            asyncio.run(MV.export_async(src, tex, str(tmp_path / "a.webm")))
        with pytest.raises(FileNotFoundError):
            asyncio.run(MV.export_async(src, str(tmp_path / "none.png"), str(tmp_path / "a.mp4")))
        with pytest.raises(FileNotFoundError):
            asyncio.run(MV.export_async(src, tex, str(tmp_path / "no" / "a.mp4")))
        with pytest.raises(RuntimeError, match="did not write"):
            asyncio.run(MV.export_async(src, tex, str(tmp_path / "a.mp4")))
    with FakeBridge("ios"):
        with pytest.raises(Exception, match="pyxpo-mesh-view"):
            asyncio.run(MV.export_async(src, tex, str(tmp_path / "a.gif")))


NODE_GIF = r"""
const fs = require("fs");
let view; global.pyxpoPage = { defineView(t, f) { view = f; }, defineModule() {} };
eval(fs.readFileSync(process.argv[2], "utf8"));
const { palette, GifWriter, gifDelay } = view.gif;
const w = 61, h = 47, frames = [];
for (let k = 0; k < 6; k++) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, inside = Math.abs(x - 10 - k * 6) < 8 && Math.abs(y - 20) < 10;
    px[i] = inside ? 200 : (x * 4) & 255; px[i + 1] = inside ? 30 : (y * 5) & 255; px[i + 2] = inside ? 90 : 128;
    px[i + 3] = 255;
  }
  frames.push(px);
}
frames.push(frames[5]);   // unchanged frame
const g = GifWriter(w, h, palette(frames));
frames.forEach((f, k) => g.frame(f, gifDelay(k, 12)));
fs.writeFileSync(process.argv[3], g.finish());
fs.writeFileSync(process.argv[3] + ".raw", Buffer.concat(frames.map((f) => Buffer.from(f))));
const W = 300, H = 200, n = new Uint8Array(W * H * 4);   // noise: fills the LZW table many times
let s = 1;
for (let i = 0; i < n.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; n[i] = i % 4 === 3 ? 255 : (s >> 16) & 255; }
const g2 = GifWriter(W, H, palette([n]));
g2.frame(n, 5);
fs.writeFileSync(process.argv[3] + ".noise", g2.finish());
fs.writeFileSync(process.argv[3] + ".noise.raw", Buffer.from(n));
const s1 = { data: Uint8Array.of(0, 0, 0, 2, 9, 9), key: true }, s2 = { data: Uint8Array.of(0, 0, 0, 1, 7), key: false };
fs.writeFileSync(process.argv[3] + ".mp4", view.mp4([s1, s2, s1], Uint8Array.of(1, 66, 0, 31, 255), 64, 48, 25));
"""


def _boxes(data, at=0, end=None):
    end = len(data) if end is None else end
    out = {}
    while at < end:
        size, kind = struct.unpack(">I4s", data[at:at + 8])
        out.setdefault(kind.decode(), []).append((at + 8, at + size))
        at += size
    assert at == end
    return out


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_web_gif_and_mp4_writers(tmp_path):
    PIL = pytest.importorskip("PIL.Image")
    from PIL import ImageSequence
    p = tmp_path / "t.gif"
    (tmp_path / "t.js").write_text(NODE_GIF)
    subprocess.run(["node", str(tmp_path / "t.js"), MV.__path__[0] + "/web.js", str(p)], check=True)
    raw = (tmp_path / "t.gif.raw").read_bytes()
    im = PIL.open(p)
    assert im.info["loop"] == 0
    got = [(f.info["duration"], f.convert("RGB").tobytes()) for f in ImageSequence.Iterator(im)]
    assert [d for d, _ in got] == [80, 90, 80, 80, 90, 80, 80]
    for k, (_, rgb) in enumerate(got):
        want = raw[k * 61 * 47 * 4:(k + 1) * 61 * 47 * 4]
        err = max(abs(rgb[i * 3 + c] - want[i * 4 + c]) for i in range(61 * 47) for c in range(3))
        assert err <= 16, (k, err)
    noise = PIL.open(str(p) + ".noise").convert("RGB").tobytes()
    want = (tmp_path / "t.gif.noise.raw").read_bytes()
    assert len(noise) == 300 * 200 * 3
    assert sum(abs(noise[i * 3] - want[i * 4]) for i in range(60000)) / 60000 < 20

    mp4 = (tmp_path / "t.gif.mp4").read_bytes()
    top = _boxes(mp4)
    assert list(top) == ["ftyp", "mdat", "moov"]
    a, b = top["mdat"][0]
    assert mp4[a:b] == bytes([0, 0, 0, 2, 9, 9, 0, 0, 0, 1, 7, 0, 0, 0, 2, 9, 9])
    trak = _boxes(mp4, *_boxes(mp4, *top["moov"][0])["trak"][0])
    stbl = _boxes(mp4, *_boxes(mp4, *_boxes(mp4, *trak["mdia"][0])["minf"][0])["stbl"][0])
    body = lambda k: mp4[stbl[k][0][0] + 4:stbl[k][0][1]]   # noqa: E731  (skip version and flags)
    assert struct.unpack(">3I", body("stts")) == (1, 3, 3600)
    assert struct.unpack(">3I", body("stss")) == (2, 1, 3)
    assert struct.unpack(">5I", body("stsz")) == (0, 3, 6, 5, 6)
    assert struct.unpack(">2I", body("stco")) == (1, a)
    assert b"avcC\x01\x42\x00\x1f\xff" in body("stsd")
