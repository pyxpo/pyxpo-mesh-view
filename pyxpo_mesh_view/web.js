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

  makeView.parse = parse;   // for tests
  pyxpoPage.defineView("PxMeshView", makeView);
  pyxpoPage.defineModule("MeshView", (method, args, page) => {
    const v = page.view(args[0]);
    if (!v) throw new Error("The MeshView is not mounted");
    switch (method) {
      case "seek": return v.seek(args[1] || 0);
      default: throw new Error("MeshView has no method " + method);
    }
  });
})();
