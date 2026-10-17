// pyxpo-mesh-view in the browser and the desktop window: plays a PXMESH1 file with WebGL.
// The page loads this file after app.js (see pyxpoPage in app.js).
(function () {
  "use strict";

  const MAGIC = "PXMESH1\0";

  // A parsed PXMESH1 file (see the package README). Typed arrays are views into `buf`.
  function parse(buf) {
    const d = new DataView(buf);
    let magic = "";
    for (let i = 0; i < 8 && i < buf.byteLength; i++) magic += String.fromCharCode(d.getUint8(i));
    if (buf.byteLength < 32 || magic !== MAGIC) throw new Error("not a PXMESH1 file");
    const v = d.getUint32(8, true), f = d.getUint32(12, true), n = d.getUint32(16, true), o = d.getUint32(20, true);
    const fps = d.getFloat32(24, true), aspect = d.getFloat32(28, true);
    if (!(v > 0 && v <= 65536 && f > 0 && n > 0 && n % 3 === 0 && o > 0)) throw new Error("PXMESH1 header has bad counts");
    if (!(fps > 0 && aspect > 0 && isFinite(fps) && isFinite(aspect))) throw new Error("PXMESH1 header has a bad fps or aspect");
    const pad = (4 - (f * 2) % 4) % 4;
    const size = 32 + v * 8 + f * v * 8 + f * 2 + pad + o * n * 2;
    if (buf.byteLength !== size) throw new Error("PXMESH1 is " + buf.byteLength + " bytes, the header says " + size);
    let at = 32;
    const uv = new Float32Array(buf, at, v * 2); at += v * 8;
    const pos = new Float32Array(buf, at, f * v * 2); at += f * v * 8;
    const orderOfFrame = new Uint16Array(buf, at, f); at += f * 2 + pad;
    const indices = new Uint16Array(buf, at, o * n);
    for (const k of orderOfFrame) if (k >= o) throw new Error("PXMESH1 frame order out of range");
    for (const k of indices) if (k >= v) throw new Error("PXMESH1 index out of range");
    return { vertices: v, frames: f, indexCount: n, fps, aspect, uv, pos, orderOfFrame, indices };
  }

  function path(p) {
    if (p && p.startsWith("file://")) p = decodeURIComponent(p.slice(7));
    return p;
  }

  const VS = "attribute vec2 a_pos; attribute vec2 a_uv; uniform vec4 u_rect; uniform vec2 u_size; varying vec2 v_uv;" +
    "void main() { vec2 p = u_rect.xy + a_pos * u_rect.zw;" +
    " gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0); v_uv = a_uv; }";
  const FS = "precision mediump float; uniform sampler2D u_tex; varying vec2 v_uv;" +
    "void main() { gl_FragColor = texture2D(u_tex, v_uv); }";

  function program(gl) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link error");
    return p;
  }

  // The dev tools show the app in a device body scaled with a CSS transform. getBoundingClientRect is in screen px
  // there, but layout (and what the app draws in) is in CSS px, so size and pointer math use the unscaled size.
  function layoutRect(el) {
    const r = el.getBoundingClientRect();
    let sx = el.offsetWidth ? r.width / el.offsetWidth : 1, sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
    if (Math.abs(sx - 1) < 0.01) sx = 1;   // keep fractional sizes when nothing is scaled
    if (Math.abs(sy - 1) < 0.01) sy = 1;
    return { left: r.left, top: r.top, width: r.width / sx, height: r.height / sy, sx, sy };
  }

  function makeView(el, emit) {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block";
    el.style.overflow = "hidden";
    el.appendChild(canvas);
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
    let prog = null, loc = null, glError = null;
    const buffers = {};
    if (!gl) glError = "WebGL is not available";
    else {
      try {
        prog = program(gl);
        loc = {
          pos: gl.getAttribLocation(prog, "a_pos"), uv: gl.getAttribLocation(prog, "a_uv"),
          rect: gl.getUniformLocation(prog, "u_rect"), size: gl.getUniformLocation(prog, "u_size"),
        };
        buffers.uv = gl.createBuffer(); buffers.pos = gl.createBuffer(); buffers.idx = gl.createBuffer();
        buffers.tex = gl.createTexture();
      } catch (e) { glError = String(e.message || e); }
    }

    let mesh = null, source = null, texture = null, gen = 0, raf = 0;
    let playing = true, loop = true, speed = 1, bg = 0;
    let startMs = performance.now(), startFrame = 0, ended = false;
    let w = 0, h = 0, dpr = 1;

    function frameNow() {
      return playing && mesh ? startFrame + (performance.now() - startMs) / 1000 * mesh.fps * speed : startFrame;
    }
    function restartClock() { startFrame = frameNow(); startMs = performance.now(); }
    function kick() { if (!raf) raf = requestAnimationFrame(draw); }

    function draw() {
      raf = 0;
      if (!gl || !prog) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      const a = ((bg >>> 24) & 255) / 255;
      gl.clearColor(((bg >>> 16) & 255) / 255 * a, ((bg >>> 8) & 255) / 255 * a, (bg & 255) / 255 * a, a);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!mesh || !canvas.width || !canvas.height) return;
      const f = mesh.frames;
      let t = Math.floor(frameNow());
      let running = playing && speed > 0;
      if (loop) t = ((t % f) + f) % f;
      else if (t >= f - 1) {
        t = f - 1;
        if (running && !ended) { ended = true; emit("end", null); }
        running = false;
      }
      const cw = canvas.width, ch = canvas.height;
      let dw = cw, dh = cw / mesh.aspect;
      if (dh > ch) { dh = ch; dw = ch * mesh.aspect; }
      gl.useProgram(prog);
      gl.uniform4f(loc.rect, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      gl.uniform2f(loc.size, cw, ch);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos);
      gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, t * mesh.vertices * 8);
      gl.enableVertexAttribArray(loc.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
      gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc.uv);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, buffers.tex);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.idx);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, mesh.orderOfFrame[t] * mesh.indexCount * 2);
      if (running) kick();
    }

    function upload(m, img) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
      gl.bufferData(gl.ARRAY_BUFFER, m.uv, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos);
      gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, buffers.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      for (const [k, val] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
                              [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) {
        gl.texParameteri(gl.TEXTURE_2D, k, val);
      }
    }

    function image(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("cannot read the texture"));
        img.src = url;
      });
    }

    function load() {
      const g = ++gen;
      mesh = null;
      kick();
      if (!source || !texture) return;
      if (glError) { emit("error", { message: glError }); return; }
      const page = window.pyxpoPage;
      const meshUrl = page.fileUrl(path(source)), texUrl = page.fileUrl(path(texture));
      if (!meshUrl || !texUrl) { emit("error", { message: "file not found" }); return; }
      Promise.all([
        fetch(meshUrl).then((r) => { if (!r.ok) throw new Error("cannot read " + source); return r.arrayBuffer(); }),
        image(texUrl),
      ]).then(([buf, img]) => {
        if (g !== gen) return;
        const m = parse(buf);
        upload(m, img);
        mesh = m;
        startFrame = 0; startMs = performance.now(); ended = false;
        emit("load", { frames: m.frames, fps: m.fps, vertices: m.vertices, triangles: m.indexCount / 3 });
        kick();
      }).catch((e) => { if (g === gen) emit("error", { message: String(e.message || e) }); });
    }

    function resize() {
      dpr = window.devicePixelRatio || 1;
      const r = layoutRect(el);
      w = r.width; h = r.height;
      canvas.width = Math.max(0, Math.round(w * dpr));
      canvas.height = Math.max(0, Math.round(h * dpr));
      kick();
    }
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(el);
    resize();

    return {
      update(props) {
        if ("playing" in props && !!props.playing !== playing) {
          restartClock(); playing = !!props.playing;
          if (playing) ended = false;
        }
        if ("loop" in props) loop = !!props.loop;
        if ("speed" in props) { restartClock(); speed = +props.speed || 0; }
        if ("background_color" in props) bg = props.background_color >>> 0;
        const src = "source" in props ? props.source || null : source;
        const tex = "texture" in props ? props.texture || null : texture;
        if (src !== source || tex !== texture) { source = src; texture = tex; load(); }
        kick();
      },
      seek(frame) { startFrame = frame; startMs = performance.now(); ended = false; kick(); },
      dispose() {
        gen++;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (ro) ro.disconnect();
        const lose = gl && gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        canvas.remove();
      },
    };
  }


  // -- export ------------------------------------------------------------------------------------
  // GIF: one palette for the clip (median cut over a few frames), each frame stores only the box of pixels that
  // changed since the one before, unchanged pixels transparent (index 255). Android uses the same encoder.

  function Bytes() {
    let buf = new Uint8Array(1 << 16), n = 0;
    function room(k) {
      if (n + k <= buf.length) return;
      let size = buf.length * 2;
      while (size < n + k) size *= 2;
      const b = new Uint8Array(size); b.set(buf.subarray(0, n)); buf = b;
    }
    return {
      byte(b) { room(1); buf[n++] = b; },
      u16(v) { room(2); buf[n++] = v & 255; buf[n++] = (v >>> 8) & 255; },
      bytes(a) { room(a.length); buf.set(a, n); n += a.length; },
      ascii(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); },
      result() { return buf.slice(0, n); },
    };
  }

  // A palette of at most 255 colours from RGBA frames (alpha ignored), and a lookup by 15-bit colour.
  function palette(samples) {
    const hist = new Uint32Array(32768);
    for (const px of samples) {
      for (let i = 0; i < px.length; i += 4) hist[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
    }
    const all = [];
    for (let c = 0; c < 32768; c++) if (hist[c]) all.push(c);
    const ch = (c, k) => k === 0 ? c >> 10 : k === 1 ? (c >> 5) & 31 : c & 31;
    const boxes = [all];
    while (boxes.length < 255) {
      let best = -1, score = 0, axis = 0;
      for (let b = 0; b < boxes.length; b++) {
        const box = boxes[b];
        if (box.length < 2) continue;
        const lo = [31, 31, 31], hi = [0, 0, 0];
        let count = 0;
        for (const c of box) {
          count += hist[c];
          for (let k = 0; k < 3; k++) { const v = ch(c, k); if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
        }
        for (let k = 0; k < 3; k++) {
          const s = (hi[k] - lo[k]) * count;
          if (s > score) { score = s; best = b; axis = k; }
        }
      }
      if (best < 0) break;
      const box = boxes[best].sort((a, b) => ch(a, axis) - ch(b, axis) || a - b);
      let total = 0;
      for (const c of box) total += hist[c];
      let acc = 0, cut = 1;
      for (let i = 0; i < box.length - 1; i++) {
        acc += hist[box[i]];
        cut = i + 1;
        if (acc * 2 >= total) break;
      }
      boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
    }
    const rgb = new Uint8Array(768);
    boxes.forEach((box, i) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const c of box) {
        const w = hist[c];
        r += w * ch(c, 0); g += w * ch(c, 1); b += w * ch(c, 2); n += w;
      }
      const e = (v) => { v = Math.round(v / Math.max(n, 1)); return (v << 3) | (v >> 2); };
      rgb[i * 3] = e(r); rgb[i * 3 + 1] = e(g); rgb[i * 3 + 2] = e(b);
    });
    const size = Math.max(boxes.length, 1);
    const lookup = new Int16Array(32768).fill(-1);
    function index(c) {
      let k = lookup[c];
      if (k >= 0) return k;
      const r = (c >> 10) << 3 | (c >> 12), g = ((c >> 5) & 31) << 3 | ((c >> 7) & 7), b = (c & 31) << 3 | ((c >> 2) & 7);
      let d = Infinity;
      for (let i = 0; i < size; i++) {
        const dr = rgb[i * 3] - r, dg = rgb[i * 3 + 1] - g, db = rgb[i * 3 + 2] - b;
        const e = dr * dr + dg * dg + db * db;
        if (e < d) { d = e; k = i; }
      }
      lookup[c] = k;
      return k;
    }
    return { rgb, index };
  }

  function GifWriter(w, h, pal) {
    const out = Bytes();
    out.ascii("GIF89a"); out.u16(w); out.u16(h);
    out.byte(0xF7); out.byte(0); out.byte(0);              // global table of 256 colours
    out.bytes(pal.rgb);
    out.byte(0x21); out.byte(0xFF); out.byte(11); out.ascii("NETSCAPE2.0");
    out.byte(3); out.byte(1); out.u16(0); out.byte(0);     // loop forever
    const stamp = new Int32Array(4096 * 256), codes = new Int16Array(4096 * 256);
    let gen = 0, prev = null;

    function lzw(px) {
      out.byte(8);
      const block = new Uint8Array(255);
      let bl = 0, acc = 0, accBits = 0, nBits = 9, maxcode = 511, free = 258, clearFlag = false;
      const flushBlock = () => { if (bl) { out.byte(bl); out.bytes(block.subarray(0, bl)); bl = 0; } };
      const charOut = (c) => { block[bl++] = c; if (bl === 255) flushBlock(); };
      function output(code) {
        acc |= code << accBits; accBits += nBits;
        while (accBits >= 8) { charOut(acc & 255); acc >>>= 8; accBits -= 8; }
        if (free > maxcode || clearFlag) {
          if (clearFlag) { nBits = 9; maxcode = 511; clearFlag = false; }
          else { nBits++; maxcode = nBits === 12 ? 4096 : (1 << nBits) - 1; }
        }
        if (code === 257) {
          if (accBits > 0) charOut(acc & 255);
          acc = 0; accBits = 0;
          flushBlock();
        }
      }
      gen++;
      output(256);
      let ent = px[0];
      for (let p = 1; p < px.length; p++) {
        const c = px[p], key = (ent << 8) | c;
        if (stamp[key] === gen) { ent = codes[key]; continue; }
        output(ent);
        ent = c;
        if (free < 4096) { stamp[key] = gen; codes[key] = free++; }
        else { gen++; free = 258; clearFlag = true; output(256); }
      }
      output(ent);
      output(257);
      out.byte(0);
    }

    return {
      // `rgba` top-down, `delay` in hundredths of a second.
      frame(rgba, delay) {
        const cur = new Uint8Array(w * h);
        for (let i = 0, p = 0; p < cur.length; i += 4, p++) {
          cur[p] = pal.index(((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3));
        }
        let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
        if (prev) {
          x0 = w; y0 = h; x1 = -1; y1 = -1;
          for (let y = 0; y < h; y++) {
            for (let x = 0, p = y * w; x < w; x++, p++) {
              if (cur[p] !== prev[p]) {
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
              }
            }
          }
          if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
        }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1, px = new Uint8Array(bw * bh);
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) {
            const p = (y0 + y) * w + x0 + x;
            px[y * bw + x] = prev && cur[p] === prev[p] ? 255 : cur[p];
          }
        }
        prev = cur;
        out.byte(0x21); out.byte(0xF9); out.byte(4); out.byte(0x05); out.u16(delay); out.byte(255); out.byte(0);
        out.byte(0x2C); out.u16(x0); out.u16(y0); out.u16(bw); out.u16(bh); out.byte(0);
        lzw(px);
      },
      finish() { out.byte(0x3B); return out.result(); },
    };
  }

  // Hundredths of a second for frame k at `fps`, rounded so the total stays on time.
  function gifDelay(k, fps) { return Math.max(2, Math.round((k + 1) * 100 / fps) - Math.round(k * 100 / fps)); }

  // MP4: one H.264 track (WebCodecs) in ftyp, mdat, moov.
  function mp4(samples, avcC, w, h, fps) {
    const SCALE = 90000, delta = Math.round(SCALE / fps), n = samples.length;
    const box = (type, ...parts) => {
      const body = Bytes();
      for (const p of parts) body.bytes(p);
      const b = body.result(), out = new Uint8Array(8 + b.length);
      new DataView(out.buffer).setUint32(0, out.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(b, 8);
      return out;
    };
    const u = (bits, ...vals) => {
      const out = new Uint8Array(vals.length * bits / 8), d = new DataView(out.buffer);
      vals.forEach((v, i) => bits === 32 ? d.setUint32(i * 4, v >>> 0) : bits === 16 ? d.setUint16(i * 2, v) : d.setUint8(i, v));
      return out;
    };
    const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    const full = (type, version, flags, ...parts) => box(type, u(32, (version << 24) | flags), ...parts);
    const matrix = u(32, 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
    const ms = Math.round(n * delta * 1000 / SCALE);
    const ftyp = box("ftyp", str("isom"), u(32, 0x200), str("isomiso2avc1mp41"));
    let dataSize = 0;
    for (const s of samples) dataSize += s.data.length;
    const mdatStart = ftyp.length + 8;
    const avc1 = box("avc1", new Uint8Array(6), u(16, 1, 0, 0), u(32, 0, 0, 0), u(16, w, h),
                     u(32, 0x480000, 0x480000, 0), u(16, 1), new Uint8Array(32), u(16, 0x18, 0xFFFF), box("avcC", avcC));
    const keys = [];
    samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    const stbl = box("stbl",
      full("stsd", 0, 0, u(32, 1), avc1),
      full("stts", 0, 0, u(32, 1, n, delta)),
      full("stss", 0, 0, u(32, keys.length, ...keys)),
      full("stsc", 0, 0, u(32, 1, 1, n, 1)),
      full("stsz", 0, 0, u(32, 0, n, ...samples.map((s) => s.data.length))),
      full("stco", 0, 0, u(32, 1, mdatStart)));
    const minf = box("minf", full("vmhd", 0, 1, u(16, 0, 0, 0, 0)),
                     box("dinf", full("dref", 0, 0, u(32, 1), full("url ", 0, 1))), stbl);
    const mdia = box("mdia", full("mdhd", 0, 0, u(32, 0, 0, SCALE, n * delta), u(16, 0x55C4, 0)),
                     full("hdlr", 0, 0, u(32, 0), str("vide"), u(32, 0, 0, 0), str("VideoHandler\0")), minf);
    const tkhd = full("tkhd", 0, 3, u(32, 0, 0, 1, 0, ms, 0, 0), u(16, 0, 0, 0, 0), matrix, u(32, w * 65536, h * 65536));
    const mvhd = full("mvhd", 0, 0, u(32, 0, 0, 1000, ms, 0x10000), u(16, 0x100, 0), u(32, 0, 0), matrix,
                      u(32, 0, 0, 0, 0, 0, 0, 2));
    const moov = box("moov", mvhd, box("trak", tkhd, mdia));
    const out = new Uint8Array(ftyp.length + 8 + dataSize + moov.length);
    out.set(ftyp, 0);
    new DataView(out.buffer).setUint32(ftyp.length, 8 + dataSize);
    out.set(str("mdat"), ftyp.length + 4);
    let at = mdatStart;
    for (const s of samples) { out.set(s.data, at); at += s.data.length; }
    out.set(moov, at);
    return out;
  }

  function base64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Draws clip frames into an offscreen WebGL canvas of the export size.
  async function renderer(o, page) {
    const [buf, img] = await Promise.all([
      fetch(page.fileUrl(path(o.source))).then((r) => { if (!r.ok) throw new Error("cannot read " + o.source); return r.arrayBuffer(); }),
      new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("cannot read the texture"));
        im.src = page.fileUrl(path(o.texture));
      }),
    ]);
    const m = parse(buf);
    const canvas = document.createElement("canvas");
    canvas.width = o.width; canvas.height = o.height;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL is not available");
    const prog = program(gl);
    const at = (n) => gl.getAttribLocation(prog, n);
    const b = { uv: gl.createBuffer(), pos: gl.createBuffer(), idx: gl.createBuffer(), tex: gl.createTexture() };
    gl.bindBuffer(gl.ARRAY_BUFFER, b.uv); gl.bufferData(gl.ARRAY_BUFFER, m.uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    for (const [k, val] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
                            [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) {
      gl.texParameteri(gl.TEXTURE_2D, k, val);
    }
    const bg = o.background_color >>> 0, rect = o.rect;
    const flipped = new Uint8Array(o.width * o.height * 4), rgba = new Uint8Array(o.width * o.height * 4);
    return {
      canvas,
      draw(t) {
        gl.viewport(0, 0, o.width, o.height);
        gl.clearColor(((bg >>> 16) & 255) / 255, ((bg >>> 8) & 255) / 255, (bg & 255) / 255, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.uniform4f(gl.getUniformLocation(prog, "u_rect"), rect[0], rect[1], rect[2], rect[3]);
        gl.uniform2f(gl.getUniformLocation(prog, "u_size"), o.width, o.height);
        gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
        gl.vertexAttribPointer(at("a_pos"), 2, gl.FLOAT, false, 0, t * m.vertices * 8);
        gl.enableVertexAttribArray(at("a_pos"));
        gl.bindBuffer(gl.ARRAY_BUFFER, b.uv);
        gl.vertexAttribPointer(at("a_uv"), 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(at("a_uv"));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, b.tex);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
        gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_SHORT, m.orderOfFrame[t] * m.indexCount * 2);
      },
      pixels() {   // RGBA top-down
        gl.readPixels(0, 0, o.width, o.height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
        const row = o.width * 4;
        for (let y = 0; y < o.height; y++) rgba.set(flipped.subarray((o.height - 1 - y) * row, (o.height - y) * row), y * row);
        return rgba;
      },
      dispose() { const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); },
    };
  }

  async function exportGif(o, r, progress) {
    const frames = o.frames;
    const picks = [0, 0.25, 0.5, 0.75].map((f) => frames[Math.floor(f * frames.length)]);
    const samples = [];
    for (const t of new Set(picks)) { r.draw(t); samples.push(r.pixels().slice()); }
    const gif = GifWriter(o.width, o.height, palette(samples));
    for (let k = 0; k < frames.length; k++) {
      r.draw(frames[k]);
      gif.frame(r.pixels(), gifDelay(k, o.fps));
      progress((k + 1) / frames.length);
      if (k % 4 === 3) await tick();
    }
    return gif.finish();
  }

  async function exportMp4(o, r, progress) {
    if (typeof VideoEncoder !== "function") throw new Error("MP4 export needs WebCodecs (Chrome 94+, Safari 16.4+, Firefox 130+)");
    const big = o.width * o.height > 921600;
    const codecs = big ? ["avc1.640028", "avc1.4D0028", "avc1.420028", "avc1.640033"]
                       : ["avc1.42E01F", "avc1.4D401F", "avc1.64001F", "avc1.640028"];
    const base = { width: o.width, height: o.height, framerate: o.fps, avc: { format: "avc" },
                   bitrate: Math.max(1e6, Math.round(o.width * o.height * o.fps * 0.2)) };
    let config = null;
    for (const codec of codecs) {
      const c = Object.assign({ codec }, base);
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; } } catch (e) { /* next */ }
    }
    if (!config) throw new Error("this browser cannot encode H.264");
    const samples = [];
    let avcC = null, failed = null;
    const enc = new VideoEncoder({
      output(chunk, meta) {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !avcC) {
          const d = meta.decoderConfig.description;
          avcC = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, key: chunk.type === "key", ts: chunk.timestamp });
      },
      error(e) { failed = e; },
    });
    enc.configure(config);
    const frames = o.frames, gop = Math.max(1, Math.round(o.fps));
    for (let k = 0; k < frames.length; k++) {
      if (failed) break;
      r.draw(frames[k]);
      const vf = new VideoFrame(r.canvas, { timestamp: Math.round(k * 1e6 / o.fps), duration: Math.round(1e6 / o.fps) });
      enc.encode(vf, { keyFrame: k % gop === 0 });
      vf.close();
      progress((k + 1) / frames.length * 0.95);
      while (enc.encodeQueueSize > 4 && !failed) await tick();
      if (k % 4 === 3) await tick();
    }
    if (!failed) await enc.flush();
    enc.close();
    if (failed) throw new Error("H.264 encoding failed: " + (failed.message || failed));
    if (!avcC || samples.length !== frames.length) throw new Error("the H.264 encoder gave no stream");
    samples.sort((a, b) => a.ts - b.ts);
    return mp4(samples, avcC, o.width, o.height, o.fps);
  }

  async function exportClip(o, page) {
    const progress = (p) => { if (page.emit) page.emit("MeshView.progress", { id: o.id, progress: p }); };
    const r = await renderer(o, page);
    try {
      const bytes = o.format === "gif" ? await exportGif(o, r, progress) : await exportMp4(o, r, progress);
      progress(1);
      return { data: base64(bytes) };
    } finally {
      r.dispose();
    }
  }

  makeView.parse = parse;   // for tests
  makeView.gif = { palette, GifWriter, gifDelay };
  makeView.mp4 = mp4;
  pyxpoPage.defineView("PxMeshView", makeView);
  pyxpoPage.defineModule("MeshView", (method, args, page) => {
    if (method === "export") return exportClip(args[0], page);
    const v = page.view(args[0]);
    if (!v) throw new Error("The MeshView is not mounted");
    switch (method) {
      case "seek": return v.seek(args[1] || 0);
      default: throw new Error("MeshView has no method " + method);
    }
  });
})();
