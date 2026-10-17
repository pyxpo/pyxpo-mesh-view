package dev.pyxpo.modules.meshview

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.Rect
import android.graphics.Shader
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** `export_async` on Android: draws the clip into an offscreen bitmap and encodes an MP4 (MediaCodec H.264 in
 *  MediaMuxer) or a GIF (the same encoder as web.js). Runs on a background thread. Python has already worked
 *  out the size, the place of the clip (`rect`), the frame list and the frame rate. */
internal object MeshExport {
    fun run(o: JSONObject, progress: (Float) -> Unit) {
        val w = o.getInt("width")
        val h = o.getInt("height")
        val fps = o.getDouble("fps")
        val fr = o.getJSONArray("frames")
        val frames = IntArray(fr.length()) { fr.getInt(it) }
        val r = o.getJSONArray("rect")
        val rect = FloatArray(4) { r.getDouble(it).toFloat() }
        val mesh = Mesh.read(File(o.getString("source")))
        if (frames.isEmpty() || frames.any { it < 0 || it >= mesh.frames }) throw IllegalArgumentException("frame out of range")
        val tex = BitmapFactory.decodeFile(o.getString("texture"))
            ?: throw IllegalArgumentException("cannot read the texture ${o.getString("texture")}")
        val out = File(o.getString("path"))
        val part = File(out.path + ".part")
        val renderer = Renderer(mesh, tex, w, h, rect, o.getLong("background_color").toInt())
        try {
            if (o.getString("format") == "gif") gif(renderer, frames, fps, part, progress)
            else mp4(renderer, frames, fps, part, progress)
            if (out.exists()) out.delete()
            if (!part.renameTo(out)) throw IllegalStateException("cannot write ${out.path}")
        } finally {
            part.delete()
            renderer.recycle()
            tex.recycle()
        }
    }

    /** Draws clip frames at the export size (twice as large then scaled down, for smooth edges). */
    private class Renderer(val mesh: Mesh, tex: Bitmap, val w: Int, val h: Int, val rect: FloatArray, val bg: Int) {
        private val ss = if (w.toLong() * h <= 1_000_000L) 2 else 1
        private val big = Bitmap.createBitmap(w * ss, h * ss, Bitmap.Config.ARGB_8888)
        private val bigCanvas = Canvas(big)
        private val small = if (ss > 1) Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888) else big
        private val smallCanvas = Canvas(small)
        private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG).apply {
            shader = BitmapShader(tex, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        }
        private val scale = Paint(Paint.FILTER_BITMAP_FLAG)
        private val texs = FloatArray(mesh.vertices * 2) { k -> mesh.uv[k] * if (k % 2 == 0) tex.width else tex.height }
        private val verts = FloatArray(mesh.vertices * 2)
        private val dst = Rect(0, 0, w, h)
        val pixels = IntArray(w * h)

        /** Frame `t` of the clip into `pixels` (ARGB, top-down). */
        fun draw(t: Int): IntArray {
            bigCanvas.drawColor(bg, PorterDuff.Mode.SRC)
            val base = t * mesh.vertices * 2
            var k = 0
            while (k < verts.size) {
                verts[k] = (rect[0] + mesh.pos[base + k] * rect[2]) * ss
                verts[k + 1] = (rect[1] + mesh.pos[base + k + 1] * rect[3]) * ss
                k += 2
            }
            val order = mesh.orderOfFrame[t].toInt() and 0xFFFF
            bigCanvas.drawVertices(Canvas.VertexMode.TRIANGLES, verts.size, verts, 0, texs, 0, null, 0,
                                   mesh.indices, order * mesh.indexCount, mesh.indexCount, paint)
            if (ss > 1) smallCanvas.drawBitmap(big, null, dst, scale)
            small.getPixels(pixels, 0, w, 0, 0, w, h)
            return pixels
        }

        fun recycle() {
            big.recycle()
            if (small !== big) small.recycle()
        }
    }

    // -- MP4 -------------------------------------------------------------------------------------------------

    private fun mp4(r: Renderer, frames: IntArray, fps: Double, file: File, progress: (Float) -> Unit) {
        val w = r.w
        val h = r.h
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            setInteger(MediaFormat.KEY_BIT_RATE, max(1_000_000, (w.toDouble() * h * fps * 0.2).toInt()))
            setInteger(MediaFormat.KEY_FRAME_RATE, max(1, fps.roundToInt()))
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        var muxer: MediaMuxer? = null
        var muxing = false
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val info = MediaCodec.BufferInfo()
            var track = -1
            var k = 0
            var inputDone = false
            var lastOutput = SystemClock.elapsedRealtime()
            val pts = { i: Int -> (i * 1_000_000.0 / fps).roundToLong() }
            while (true) {
                if (!inputDone) {
                    val i = codec.dequeueInputBuffer(10_000)
                    if (i >= 0) {
                        if (k == frames.size) {
                            codec.queueInputBuffer(i, 0, 0, pts(k), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            val px = r.draw(frames[k])
                            val img = codec.getInputImage(i) ?: throw IllegalStateException("the H.264 encoder gave no input image")
                            fillYuv(img, px, w, h)
                            codec.queueInputBuffer(i, 0, w * h * 3 / 2, pts(k), 0)
                            k++
                            progress(k * 0.97f / frames.size)
                        }
                    }
                }
                val j = codec.dequeueOutputBuffer(info, if (inputDone) 10_000 else 0)
                when {
                    j == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                        if (SystemClock.elapsedRealtime() - lastOutput > 10_000) throw IllegalStateException("the H.264 encoder stopped")
                    }
                    j == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                        muxing = true
                    }
                    j >= 0 -> {
                        lastOutput = SystemClock.elapsedRealtime()
                        val buf = codec.getOutputBuffer(j)
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0 && buf != null) {
                            if (!muxing) throw IllegalStateException("the H.264 encoder gave data before its format")
                            buf.position(info.offset)
                            buf.limit(info.offset + info.size)
                            muxer.writeSampleData(track, buf, info)
                        }
                        codec.releaseOutputBuffer(j, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                    }
                }
            }
        } finally {
            try { codec.stop() } catch (_: Throwable) {}
            codec.release()
            if (muxing) try { muxer?.stop() } catch (_: Throwable) {}
            muxer?.release()
        }
    }

    /** ARGB pixels into a YUV 4:2:0 input image (BT.601 limited range, any plane layout). */
    private fun fillYuv(img: Image, px: IntArray, w: Int, h: Int) {
        val planes = img.planes
        val yb = planes[0].buffer
        val ys = planes[0].rowStride
        val yp = planes[0].pixelStride
        val row = ByteArray(w)
        for (y in 0 until h) {
            var i = y * w
            for (x in 0 until w) {
                val c = px[i++]
                val r = (c shr 16) and 255
                val g = (c shr 8) and 255
                val b = c and 255
                row[x] = (((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).toByte()
            }
            if (yp == 1) {
                yb.position(y * ys)
                yb.put(row, 0, w)
            } else {
                for (x in 0 until w) yb.put(y * ys + x * yp, row[x])
            }
        }
        val ub = planes[1].buffer
        val us = planes[1].rowStride
        val up = planes[1].pixelStride
        val vb = planes[2].buffer
        val vs = planes[2].rowStride
        val vp = planes[2].pixelStride
        for (y in 0 until h / 2) {
            for (x in 0 until w / 2) {
                var r = 0
                var g = 0
                var b = 0
                for (q in 0 until 4) {
                    val c = px[(y * 2 + q / 2) * w + x * 2 + q % 2]
                    r += (c shr 16) and 255
                    g += (c shr 8) and 255
                    b += c and 255
                }
                r = (r + 2) shr 2
                g = (g + 2) shr 2
                b = (b + 2) shr 2
                ub.put(y * us + x * up, (((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128).toByte())
                vb.put(y * vs + x * vp, (((112 * r - 94 * g - 18 * b + 128) shr 8) + 128).toByte())
            }
        }
    }

    // -- GIF (same as web.js) --------------------------------------------------------------------------------

    private fun gif(r: Renderer, frames: IntArray, fps: Double, file: File, progress: (Float) -> Unit) {
        val picks = listOf(0.0, 0.25, 0.5, 0.75).map { frames[(it * frames.size).toInt()] }.distinct()
        val pal = Palette(picks.map { r.draw(it).copyOf() })
        BufferedOutputStream(FileOutputStream(file), 1 shl 16).use { s ->
            val gw = GifWriter(s, r.w, r.h, pal)
            for (k in frames.indices) {
                gw.frame(r.draw(frames[k]), max(2, ((k + 1) * 100 / fps).roundToInt() - (k * 100 / fps).roundToInt()))
                progress((k + 1).toFloat() / frames.size)
            }
            gw.finish()
        }
    }

    private fun key(c: Int) = (((c shr 19) and 31) shl 10) or (((c shr 11) and 31) shl 5) or ((c shr 3) and 31)

    private fun ch(c: Int, k: Int) = when (k) { 0 -> c shr 10; 1 -> (c shr 5) and 31; else -> c and 31 }

    /** At most 255 colours by median cut over a 15-bit histogram; index 255 stays free for "unchanged". */
    private class Palette(samples: List<IntArray>) {
        val rgb = ByteArray(768)
        private val size: Int
        private val lookup = ShortArray(32768) { -1 }

        init {
            val hist = IntArray(32768)
            for (px in samples) for (c in px) hist[key(c)]++
            val boxes = ArrayList<IntArray>()
            boxes.add((0 until 32768).filter { hist[it] > 0 }.toIntArray())
            while (boxes.size < 255) {
                var best = -1
                var score = 0L
                var axis = 0
                for (bi in boxes.indices) {
                    val box = boxes[bi]
                    if (box.size < 2) continue
                    val lo = intArrayOf(31, 31, 31)
                    val hi = intArrayOf(0, 0, 0)
                    var count = 0L
                    for (c in box) {
                        count += hist[c]
                        for (k in 0 until 3) {
                            val v = ch(c, k)
                            if (v < lo[k]) lo[k] = v
                            if (v > hi[k]) hi[k] = v
                        }
                    }
                    for (k in 0 until 3) {
                        val s = (hi[k] - lo[k]) * count
                        if (s > score) { score = s; best = bi; axis = k }
                    }
                }
                if (best < 0) break
                val ax = axis
                val box = boxes[best].sortedWith(compareBy<Int>({ ch(it, ax) }, { it })).toIntArray()
                var total = 0L
                for (c in box) total += hist[c]
                var acc = 0L
                var cut = 1
                for (i in 0 until box.size - 1) {
                    acc += hist[box[i]]
                    cut = i + 1
                    if (acc * 2 >= total) break
                }
                boxes[best] = box.copyOfRange(0, cut)
                boxes.add(best + 1, box.copyOfRange(cut, box.size))
            }
            boxes.forEachIndexed { i, box ->
                var r = 0.0
                var g = 0.0
                var b = 0.0
                var n = 0.0
                for (c in box) {
                    val wt = hist[c].toDouble()
                    r += wt * ch(c, 0); g += wt * ch(c, 1); b += wt * ch(c, 2); n += wt
                }
                fun e(v: Double): Byte { val q = Math.round(v / max(n, 1.0)).toInt(); return ((q shl 3) or (q shr 2)).toByte() }
                rgb[i * 3] = e(r); rgb[i * 3 + 1] = e(g); rgb[i * 3 + 2] = e(b)
            }
            size = max(boxes.size, 1)
        }

        fun index(c: Int): Int {
            val known = lookup[c].toInt()
            if (known >= 0) return known
            val r = ((c shr 10) shl 3) or (c shr 12)
            val g = (((c shr 5) and 31) shl 3) or ((c shr 7) and 7)
            val b = ((c and 31) shl 3) or ((c shr 2) and 7)
            var best = 0
            var d = Int.MAX_VALUE
            for (i in 0 until size) {
                val dr = (rgb[i * 3].toInt() and 255) - r
                val dg = (rgb[i * 3 + 1].toInt() and 255) - g
                val db = (rgb[i * 3 + 2].toInt() and 255) - b
                val e = dr * dr + dg * dg + db * db
                if (e < d) { d = e; best = i }
            }
            lookup[c] = best.toShort()
            return best
        }
    }

    private class GifWriter(private val out: OutputStream, private val w: Int, private val h: Int, private val pal: Palette) {
        private val stamp = IntArray(4096 * 256)
        private val codes = ShortArray(4096 * 256)
        private var gen = 0
        private var prev: ByteArray? = null
        private val block = ByteArray(255)

        init {
            out.write("GIF89a".toByteArray(Charsets.US_ASCII)); u16(w); u16(h)
            out.write(0xF7); out.write(0); out.write(0)          // global table of 256 colours
            out.write(pal.rgb)
            out.write(0x21); out.write(0xFF); out.write(11); out.write("NETSCAPE2.0".toByteArray(Charsets.US_ASCII))
            out.write(3); out.write(1); u16(0); out.write(0)     // loop forever
        }

        private fun u16(v: Int) { out.write(v and 255); out.write((v shr 8) and 255) }

        /** `argb` top-down, `delay` in hundredths of a second. */
        fun frame(argb: IntArray, delay: Int) {
            val cur = ByteArray(w * h)
            for (p in cur.indices) cur[p] = pal.index(key(argb[p])).toByte()
            val old = prev
            var x0 = 0; var y0 = 0; var x1 = w - 1; var y1 = h - 1
            if (old != null) {
                x0 = w; y0 = h; x1 = -1; y1 = -1
                for (y in 0 until h) {
                    var p = y * w
                    for (x in 0 until w) {
                        if (cur[p] != old[p]) {
                            if (x < x0) x0 = x
                            if (x > x1) x1 = x
                            if (y < y0) y0 = y
                            if (y > y1) y1 = y
                        }
                        p++
                    }
                }
                if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0 }
            }
            val bw = x1 - x0 + 1
            val bh = y1 - y0 + 1
            val px = ByteArray(bw * bh)
            for (y in 0 until bh) {
                for (x in 0 until bw) {
                    val p = (y0 + y) * w + x0 + x
                    px[y * bw + x] = if (old != null && cur[p] == old[p]) 255.toByte() else cur[p]
                }
            }
            prev = cur
            out.write(0x21); out.write(0xF9); out.write(4); out.write(0x05); u16(delay); out.write(255); out.write(0)
            out.write(0x2C); u16(x0); u16(y0); u16(bw); u16(bh); out.write(0)
            lzw(px)
        }

        fun finish() { out.write(0x3B) }

        private var bl = 0
        private var acc = 0
        private var accBits = 0
        private var nBits = 9
        private var maxcode = 511
        private var free = 258
        private var clearFlag = false

        private fun flushBlock() { if (bl > 0) { out.write(bl); out.write(block, 0, bl); bl = 0 } }

        private fun charOut(c: Int) { block[bl++] = c.toByte(); if (bl == 255) flushBlock() }

        private fun output(code: Int) {
            acc = acc or (code shl accBits)
            accBits += nBits
            while (accBits >= 8) { charOut(acc and 255); acc = acc ushr 8; accBits -= 8 }
            if (free > maxcode || clearFlag) {
                if (clearFlag) { nBits = 9; maxcode = 511; clearFlag = false }
                else { nBits++; maxcode = if (nBits == 12) 4096 else (1 shl nBits) - 1 }
            }
            if (code == 257) {
                if (accBits > 0) charOut(acc and 255)
                acc = 0; accBits = 0
                flushBlock()
            }
        }

        private fun lzw(px: ByteArray) {
            out.write(8)
            bl = 0; acc = 0; accBits = 0; nBits = 9; maxcode = 511; free = 258; clearFlag = false
            gen++
            output(256)
            var ent = px[0].toInt() and 255
            for (p in 1 until px.size) {
                val c = px[p].toInt() and 255
                val k = (ent shl 8) or c
                if (stamp[k] == gen) { ent = codes[k].toInt(); continue }
                output(ent)
                ent = c
                if (free < 4096) { stamp[k] = gen; codes[k] = (free++).toShort() }
                else { gen++; free = 258; clearFlag = true; output(256) }
            }
            output(ent)
            output(257)
            out.write(0)
        }
    }
}
