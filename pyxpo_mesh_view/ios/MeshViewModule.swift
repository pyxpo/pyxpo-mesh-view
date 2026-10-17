import Metal
import MetalKit
import UIKit

/// pyxpo-mesh-view on iOS: a Metal view (`PxMeshView`) that plays a PXMESH1 file.
final class MeshViewModule: PxViewModule {
    static let moduleName = "MeshView"
    static let viewTypes = ["PxMeshView"]

    required init() {}

    func makeView(_ ctx: PxModuleContext, _ type: String, _ emit: @escaping (String, Any?) -> Void) -> PxNativeView {
        PxMeshView(emit)
    }

    func call(_ ctx: PxModuleContext, _ method: String, _ args: [Any], _ reply: @escaping PxReply) {
        DispatchQueue.main.async {
            guard let tag = (args.first as? NSNumber)?.intValue, let v = ctx.view(tag) as? PxMeshView else {
                reply(nil, "The MeshView is not mounted")
                return
            }
            switch method {
            case "seek":
                v.player.seek(args.count > 1 ? (args[1] as? NSNumber)?.intValue ?? 0 : 0)
                reply(nil, nil)
            default:
                reply(nil, "MeshView has no method \(method)")
            }
        }
    }
}

struct MeshError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// A parsed PXMESH1 file (see the package README).
struct Mesh {
    let vertices: Int, frames: Int, indexCount: Int, orders: Int
    let fps: Float, aspect: Float
    let uv: [Float], pos: [Float], orderOfFrame: [UInt16], indices: [UInt16]

    init(_ d: Data) throws {
        guard d.count >= 32, d.prefix(8) == Data("PXMESH1\0".utf8) else { throw MeshError(message: "not a PXMESH1 file") }
        func u32(_ at: Int) -> Int { Int(d.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: at, as: UInt32.self) }.littleEndian) }
        func f32(_ at: Int) -> Float { Float(bitPattern: UInt32(u32(at))) }
        let v = u32(8), f = u32(12), n = u32(16), o = u32(20)
        let fps = f32(24), aspect = f32(28)
        guard v > 0, v <= 65536, f > 0, n > 0, n % 3 == 0, o > 0 else { throw MeshError(message: "PXMESH1 header has bad counts") }
        guard fps > 0, aspect > 0, fps.isFinite, aspect.isFinite else {
            throw MeshError(message: "PXMESH1 header has a bad fps or aspect")
        }
        let pad = (4 - (f * 2) % 4) % 4
        let size = 32 + v * 8 + f * v * 8 + f * 2 + pad + o * n * 2
        guard d.count == size else { throw MeshError(message: "PXMESH1 is \(d.count) bytes, the header says \(size)") }
        func array<T>(_ at: Int, _ count: Int, _ t: T.Type) -> [T] {
            d.withUnsafeBytes { raw in
                (0..<count).map { raw.loadUnaligned(fromByteOffset: at + $0 * MemoryLayout<T>.stride, as: T.self) }
            }
        }
        var at = 32
        uv = array(at, v * 2, Float.self); at += v * 8
        pos = array(at, f * v * 2, Float.self); at += f * v * 8
        orderOfFrame = array(at, f, UInt16.self); at += f * 2 + pad
        indices = array(at, o * n, UInt16.self)
        guard orderOfFrame.allSatisfy({ Int($0) < o }) else { throw MeshError(message: "PXMESH1 frame order out of range") }
        guard indices.allSatisfy({ Int($0) < v }) else { throw MeshError(message: "PXMESH1 index out of range") }
        (vertices, frames, indexCount, orders, self.fps, self.aspect) = (v, f, n, o, fps, aspect)
    }
}

final class PxMeshView: PxNativeView {
    let player: MeshPlayer
    var view: UIView { player }

    init(_ emit: @escaping (String, Any?) -> Void) { player = MeshPlayer(emit) }

    func update(_ props: [String: Any], _ removed: [String]) {
        if let p = props["playing"] as? Bool { player.setPlaying(p) }
        if let l = props["loop"] as? Bool { player.loop = l }
        if let s = props["speed"] as? NSNumber { player.setSpeed(s.floatValue) }
        if let b = props["background_color"] as? NSNumber { player.background = b.uint32Value }
        let src = props.keys.contains("source") ? props["source"] as? String : player.source
        let tex = props.keys.contains("texture") ? props["texture"] as? String : player.texture
        if src != player.source || tex != player.texture { player.load(src, tex) }
        player.kick()
    }

    func dispose() { player.dispose() }
}

private let shaderSource = """
#include <metal_stdlib>
using namespace metal;
struct VOut { float4 pos [[position]]; float2 uv; };
struct U { float4 rect; float2 size; };
vertex VOut mv_vertex(uint vid [[vertex_id]], const device float2 *pos [[buffer(0)]],
                      const device float2 *uv [[buffer(1)]], constant U &u [[buffer(2)]]) {
    float2 p = u.rect.xy + pos[vid] * u.rect.zw;
    VOut o;
    o.pos = float4(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, 0.0, 1.0);
    o.uv = uv[vid];
    return o;
}
fragment float4 mv_fragment(VOut in [[stage_in]], texture2d<float> tex [[texture(0)]], sampler s [[sampler(0)]]) {
    return tex.sample(s, in.uv);
}
"""

final class MeshPlayer: MTKView, MTKViewDelegate {
    private let emit: (String, Any?) -> Void
    private(set) var source: String?
    private(set) var texture: String?
    var loop = true
    var background: UInt32 = 0 { didSet { applyBackground() } }
    private var playing = true
    private var speed: Float = 1
    private var mesh: Mesh?
    private var posBuffer: MTLBuffer?
    private var uvBuffer: MTLBuffer?
    private var orderBuffers: [MTLBuffer] = []
    private var tex: MTLTexture?
    private var pipeline: MTLRenderPipelineState?
    private var sampler: MTLSamplerState?
    private var queue: MTLCommandQueue?
    private var setupError: String?
    private var generation = 0
    // The clock: frame = startFrame + (now - startTime) * fps * speed while playing.
    private var startTime = CACurrentMediaTime()
    private var startFrame: Double = 0
    private var ended = false

    init(_ emit: @escaping (String, Any?) -> Void) {
        self.emit = emit
        super.init(frame: .zero, device: MTLCreateSystemDefaultDevice())
        delegate = self
        isOpaque = false
        layer.isOpaque = false
        framebufferOnly = true
        colorPixelFormat = .bgra8Unorm
        preferredFramesPerSecond = 60
        isPaused = true
        enableSetNeedsDisplay = true
        applyBackground()
        setUp()
    }

    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func setUp() {
        guard let dev = device else { setupError = "Metal is not available"; return }
        do {
            let lib = try dev.makeLibrary(source: shaderSource, options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "mv_vertex")
            d.fragmentFunction = lib.makeFunction(name: "mv_fragment")
            let c = d.colorAttachments[0]!
            c.pixelFormat = colorPixelFormat
            c.isBlendingEnabled = true
            c.sourceRGBBlendFactor = .sourceAlpha
            c.destinationRGBBlendFactor = .oneMinusSourceAlpha
            c.sourceAlphaBlendFactor = .one
            c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            pipeline = try dev.makeRenderPipelineState(descriptor: d)
            let s = MTLSamplerDescriptor()
            s.minFilter = .linear
            s.magFilter = .linear
            s.sAddressMode = .clampToEdge
            s.tAddressMode = .clampToEdge
            sampler = dev.makeSamplerState(descriptor: s)
            queue = dev.makeCommandQueue()
        } catch {
            setupError = error.localizedDescription
        }
    }

    private func applyBackground() {
        let v = background
        let a = Double((v >> 24) & 255) / 255
        clearColor = MTLClearColor(red: Double((v >> 16) & 255) / 255 * a, green: Double((v >> 8) & 255) / 255 * a,
                                   blue: Double(v & 255) / 255 * a, alpha: a)
        setNeedsDisplay()
    }

    func load(_ src: String?, _ texPath: String?) {
        source = src
        texture = texPath
        generation += 1
        let gen = generation
        mesh = nil
        setNeedsDisplay()
        guard let src = src, let texPath = texPath else { return }
        if let e = setupError { emit("error", ["message": e]); return }
        guard let dev = device else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let m = try Mesh(Data(contentsOf: URL(fileURLWithPath: src)))
                let t = try MTKTextureLoader(device: dev).newTexture(URL: URL(fileURLWithPath: texPath), options: [
                    .SRGB: false, .origin: MTKTextureLoader.Origin.topLeft])
                let pos = m.pos.withUnsafeBytes { dev.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }
                let uv = m.uv.withUnsafeBytes { dev.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }
                // One buffer per order: Metal wants index buffer offsets 4-byte aligned.
                let orders: [MTLBuffer] = (0..<m.orders).compactMap { k in
                    m.indices[k * m.indexCount..<(k + 1) * m.indexCount].withUnsafeBytes {
                        dev.makeBuffer(bytes: $0.baseAddress!, length: $0.count)
                    }
                }
                DispatchQueue.main.async {
                    guard let self = self, gen == self.generation else { return }
                    (self.mesh, self.tex, self.posBuffer, self.uvBuffer, self.orderBuffers) = (m, t, pos, uv, orders)
                    self.startFrame = 0
                    self.startTime = CACurrentMediaTime()
                    self.ended = false
                    self.emit("load", ["frames": m.frames, "fps": Double(m.fps), "vertices": m.vertices,
                                       "triangles": m.indexCount / 3])
                    self.kick()
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self = self, gen == self.generation else { return }
                    self.emit("error", ["message": error.localizedDescription])
                }
            }
        }
    }

    private func frameNow() -> Double {
        guard playing, let m = mesh else { return startFrame }
        return startFrame + (CACurrentMediaTime() - startTime) * Double(m.fps) * Double(speed)
    }

    private func restartClock() {
        startFrame = frameNow()
        startTime = CACurrentMediaTime()
    }

    /// Runs the display loop while there is something to play, else draws on demand.
    func kick() {
        let run = mesh != nil && playing && speed > 0 && !(ended && !loop)
        isPaused = !run
        enableSetNeedsDisplay = !run
        if !run { setNeedsDisplay() }
    }

    func setPlaying(_ p: Bool) {
        guard p != playing else { return }
        restartClock()
        playing = p
        if p { ended = false }
        kick()
    }

    func setSpeed(_ s: Float) {
        restartClock()
        speed = s
        kick()
    }

    func seek(_ frame: Int) {
        startFrame = Double(max(0, frame))
        startTime = CACurrentMediaTime()
        ended = false
        kick()
    }

    func dispose() {
        generation += 1
        isPaused = true
        mesh = nil
        tex = nil
        posBuffer = nil
        uvBuffer = nil
        orderBuffers = []
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { setNeedsDisplay() }

    func draw(in view: MTKView) {
        guard let queue = queue, let pass = currentRenderPassDescriptor, let drawable = currentDrawable,
              let cmd = queue.makeCommandBuffer(), let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        if let m = mesh, let pipeline = pipeline, let pos = posBuffer, let uv = uvBuffer, let tex = tex {
            let f = m.frames
            var t = Int(frameNow().rounded(.down))
            if loop {
                t = ((t % f) + f) % f
            } else if t >= f - 1 {
                t = f - 1
                if playing && speed > 0 && !ended {
                    ended = true
                    emit("end", nil)
                    DispatchQueue.main.async { [weak self] in self?.kick() }
                }
            }
            let cw = Float(drawableSize.width), ch = Float(drawableSize.height)
            var dw = cw, dh = cw / m.aspect
            if dh > ch { dh = ch; dw = ch * m.aspect }
            var u: [Float] = [(cw - dw) / 2, (ch - dh) / 2, dw, dh, cw, ch, 0, 0]
            enc.setRenderPipelineState(pipeline)
            enc.setVertexBuffer(pos, offset: t * m.vertices * 8, index: 0)
            enc.setVertexBuffer(uv, offset: 0, index: 1)
            enc.setVertexBytes(&u, length: u.count * 4, index: 2)
            enc.setFragmentTexture(tex, index: 0)
            enc.setFragmentSamplerState(sampler, index: 0)
            enc.drawIndexedPrimitives(type: .triangle, indexCount: m.indexCount, indexType: .uint16,
                                      indexBuffer: orderBuffers[Int(m.orderOfFrame[t])], indexBufferOffset: 0)
        }
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
    }
}
