package dev.pyxpo.modules.meshview

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import dev.pyxpo.moduleapi.PxNativeView
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

/** A parsed PXMESH1 file (see the package README). */
class Mesh(val vertices: Int, val frames: Int, val indexCount: Int, val fps: Float, val aspect: Float,
           val uv: FloatArray, val pos: FloatArray, val orderOfFrame: ShortArray, val indices: ShortArray) {
    companion object {
        private val MAGIC = "PXMESH1\u0000".toByteArray(Charsets.US_ASCII)

        fun read(file: File): Mesh {
            val bytes = file.readBytes()
            require(bytes.size >= 32 && bytes.copyOfRange(0, 8).contentEquals(MAGIC)) { "not a PXMESH1 file" }
            val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            b.position(8)
            val v = b.int
            val f = b.int
            val i = b.int
            val o = b.int
            val fps = b.float
            val aspect = b.float
            require(v in 1..65536 && f > 0 && i > 0 && i % 3 == 0 && o > 0) { "PXMESH1 header has bad counts" }
            require(fps > 0 && aspect > 0 && fps.isFinite() && aspect.isFinite()) { "PXMESH1 header has a bad fps or aspect" }
            val size = 32L + v * 8L + f.toLong() * v * 8L + f * 2L + ((4 - (f * 2) % 4) % 4) + o.toLong() * i * 2L
            require(bytes.size.toLong() == size) { "PXMESH1 is ${bytes.size} bytes, the header says $size" }
            val uv = FloatArray(v * 2).also { b.asFloatBuffer().get(it) }
            b.position(b.position() + v * 8)
            val pos = FloatArray(f * v * 2).also { b.asFloatBuffer().get(it) }
            b.position(b.position() + f * v * 8)
            val of = ShortArray(f).also { b.asShortBuffer().get(it) }
            b.position(b.position() + f * 2 + (4 - (f * 2) % 4) % 4)
            val idx = ShortArray(o * i).also { b.asShortBuffer().get(it) }
            for (k in of) require((k.toInt() and 0xFFFF) < o) { "PXMESH1 frame order out of range" }
            for (k in idx) require((k.toInt() and 0xFFFF) < v) { "PXMESH1 index out of range" }
            return Mesh(v, f, i, fps, aspect, uv, pos, of, idx)
        }
    }
}

class MeshView(context: Context, emit: (String, Any?) -> Unit) : PxNativeView {
    val player = MeshPlayer(context, emit)
    override val view: View get() = player

    override fun update(props: JSONObject, removed: Set<String>) {
        if (props.has("playing")) player.setPlaying(props.getBoolean("playing"))
        if (props.has("loop")) player.loop = props.getBoolean("loop")
        if (props.has("speed")) player.setSpeed(props.getDouble("speed").toFloat())
        if (props.has("background_color")) { player.bgColor = props.getLong("background_color").toInt(); player.invalidate() }
        val src = if (props.has("source")) props.optString("source").takeUnless { props.isNull("source") } else player.source
        val tex = if (props.has("texture")) props.optString("texture").takeUnless { props.isNull("texture") } else player.texture
        if (src != player.source || tex != player.texture) player.load(src, tex)
    }

    override fun dispose() = player.dispose()
}

@SuppressLint("ViewConstructor")
class MeshPlayer(context: Context, private val emit: (String, Any?) -> Unit) : View(context) {
    var source: String? = null
        private set
    var texture: String? = null
        private set
    var loop = true
    var bgColor = 0
    private var playing = true
    private var speed = 1f
    private var mesh: Mesh? = null
    private var bitmap: Bitmap? = null
    private var paint: Paint? = null
    private var texs = FloatArray(0)
    private var verts = FloatArray(0)
    private var generation = 0
    private val main = Handler(Looper.getMainLooper())
    // The clock: frame = startFrame + (now - startNanos) * fps * speed while playing.
    private var startNanos = 0L
    private var startFrame = 0.0
    private var ended = false
    private var drawnFrame = -1

    init {
        // drawVertices with a shader is hardware accelerated from Android 10 only.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    fun load(src: String?, tex: String?) {
        source = src
        texture = tex
        val gen = ++generation
        if (src == null || tex == null) { show(gen, null, null); return }
        thread(name = "MeshView.load") {
            try {
                val m = Mesh.read(File(src))
                val bm = BitmapFactory.decodeFile(tex) ?: throw IllegalArgumentException("cannot read the texture $tex")
                main.post { if (gen == generation) show(gen, m, bm) else bm.recycle() }
            } catch (e: Throwable) {
                main.post { if (gen == generation) { show(gen, null, null); emit("error", mapOf("message" to (e.message ?: e.toString()))) } }
            }
        }
    }

    private fun show(gen: Int, m: Mesh?, bm: Bitmap?) {
        if (gen != generation) return
        bitmap?.recycle()
        mesh = m
        bitmap = bm
        paint = bm?.let {
            Paint(Paint.FILTER_BITMAP_FLAG).apply { shader = BitmapShader(it, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
        }
        if (m != null && bm != null) {
            texs = FloatArray(m.vertices * 2) { k -> m.uv[k] * if (k % 2 == 0) bm.width else bm.height }
            verts = FloatArray(m.vertices * 2)
            startFrame = 0.0
            startNanos = SystemClock.elapsedRealtimeNanos()
            ended = false
            emit("load", mapOf("frames" to m.frames, "fps" to m.fps.toDouble(), "vertices" to m.vertices,
                               "triangles" to m.indexCount / 3))
        }
        invalidate()
    }

    private fun frameNow(): Double =
        if (playing) startFrame + (SystemClock.elapsedRealtimeNanos() - startNanos) / 1e9 * (mesh?.fps ?: 0f) * speed else startFrame

    private fun restartClock() {
        startFrame = frameNow()
        startNanos = SystemClock.elapsedRealtimeNanos()
    }

    fun setPlaying(p: Boolean) {
        if (p == playing) return
        restartClock()
        playing = p
        if (p) ended = false
        invalidate()
    }

    fun setSpeed(s: Float) {
        restartClock()
        speed = s
        invalidate()
    }

    fun seek(frame: Int) {
        startFrame = frame.toDouble()
        startNanos = SystemClock.elapsedRealtimeNanos()
        ended = false
        invalidate()
    }

    fun dispose() {
        generation++
        bitmap?.recycle()
        bitmap = null
        mesh = null
    }

    /** The frame to show now: wrapped when looping, else held on the last one. */
    private fun shownFrame(m: Mesh): Int {
        val t = frameNow().toLong()
        val f = m.frames.toLong()
        return (if (loop) Math.floorMod(t, f) else t.coerceIn(0, f - 1)).toInt()
    }

    // Clips are 30 fps and displays 60 Hz or more: wait for the next vsync where the frame changes, then draw.
    private val tick = object : Runnable {
        override fun run() {
            val m = mesh ?: return
            if (!isAttachedToWindow) return
            if (shownFrame(m) != drawnFrame) invalidate() else postOnAnimation(this)
        }
    }

    override fun onDraw(canvas: Canvas) {
        if (bgColor != 0) canvas.drawColor(bgColor)
        val m = mesh ?: return
        val p = paint ?: return
        val frame = shownFrame(m)
        var running = playing && speed > 0f
        if (!loop && frameNow() >= m.frames - 1) {
            if (running && !ended) { ended = true; emit("end", null) }
            running = false
        }
        drawnFrame = frame
        val w = width.toFloat()
        val h = height.toFloat()
        var dw = w
        var dh = w / m.aspect
        if (dh > h) { dh = h; dw = h * m.aspect }
        val ox = (w - dw) / 2
        val oy = (h - dh) / 2
        val base = frame * m.vertices * 2
        val pos = m.pos
        var k = 0
        while (k < verts.size) {
            verts[k] = ox + pos[base + k] * dw
            verts[k + 1] = oy + pos[base + k + 1] * dh
            k += 2
        }
        val order = m.orderOfFrame[frame].toInt() and 0xFFFF
        canvas.drawVertices(Canvas.VertexMode.TRIANGLES, verts.size, verts, 0, texs, 0, null, 0,
                            m.indices, order * m.indexCount, m.indexCount, p)
        removeCallbacks(tick)
        if (running && isAttachedToWindow) postOnAnimation(tick)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        invalidate()
    }
}
