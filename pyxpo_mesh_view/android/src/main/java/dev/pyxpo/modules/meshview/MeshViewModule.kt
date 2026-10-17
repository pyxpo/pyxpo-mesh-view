package dev.pyxpo.modules.meshview

import dev.pyxpo.moduleapi.PxModule
import dev.pyxpo.moduleapi.PxModuleContext
import dev.pyxpo.moduleapi.PxNativeView
import dev.pyxpo.moduleapi.PxReply
import org.json.JSONArray
import kotlin.concurrent.thread

/** pyxpo-mesh-view on Android: a view (`PxMeshView`) that plays a PXMESH1 file with `Canvas.drawVertices`,
 *  and `export` (MP4 or GIF, see MeshExport). */
class MeshViewModule : PxModule() {
    override val name = "MeshView"
    override val viewTypes = setOf("PxMeshView")

    override fun makeView(ctx: PxModuleContext, type: String, emit: (name: String, value: Any?) -> Unit): PxNativeView =
        MeshView(ctx.activity, emit)

    override fun call(ctx: PxModuleContext, method: String, args: JSONArray, reply: PxReply) {
        if (method == "export") {
            val o = args.getJSONObject(0)
            val id = o.optInt("id")
            thread(name = "MeshView.export") {
                try {
                    var last = -1
                    MeshExport.run(o) { p ->
                        val pct = (p * 100).toInt()
                        if (pct != last) { last = pct; ctx.emit("MeshView.progress", mapOf("id" to id, "progress" to p.toDouble())) }
                    }
                    reply(null, null)
                } catch (e: Throwable) {
                    reply(null, "export failed: " + (e.message ?: e.toString()))
                }
            }
            return
        }
        val v = (if (args.length() > 0) ctx.view(args.optInt(0, -1)) else null) as? MeshView
            ?: run { reply(null, "The MeshView is not mounted"); return }
        when (method) {
            "seek" -> { v.player.seek(args.optInt(1, 0)); reply(null, null) }
            else -> reply(null, "MeshView has no method $method")
        }
    }
}
