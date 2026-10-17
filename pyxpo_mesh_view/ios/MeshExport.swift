import AVFoundation
import ImageIO
import Metal
import MetalKit
import UniformTypeIdentifiers

/// `export_async` on iOS: draws the clip with Metal into an offscreen texture (4x MSAA) and encodes an MP4
/// (AVAssetWriter, H.264) or a GIF (ImageIO). Runs on a background queue. Python has already worked out the size,
/// the place of the clip (`rect`), the frame list and the frame rate.
enum MeshExport {
    static func run(_ o: [String: Any], progress: @escaping (Double) -> Void) throws {
        func num(_ k: String) throws -> Double {
            guard let v = (o[k] as? NSNumber)?.doubleValue else { throw MeshError(message: "export needs \(k)") }
            return v
        }
        func str(_ k: String) throws -> String {
            guard let v = o[k] as? String else { throw MeshError(message: "export needs \(k)") }
            return v
        }
        let w = Int(try num("width")), h = Int(try num("height")), fps = try num("fps")
        let frames = (o["frames"] as? [NSNumber] ?? []).map { $0.intValue }
        let rect = (o["rect"] as? [NSNumber] ?? []).map { $0.floatValue }
        guard rect.count == 4, w > 0, h > 0, fps > 0 else { throw MeshError(message: "export got a bad size or rect") }
        let mesh = try Mesh(Data(contentsOf: URL(fileURLWithPath: try str("source"))))
        guard !frames.isEmpty, frames.allSatisfy({ $0 >= 0 && $0 < mesh.frames }) else {
            throw MeshError(message: "frame out of range")
        }
        let r = try Renderer(mesh, try str("texture"), w, h, rect, UInt32(truncatingIfNeeded: Int64(try num("background_color"))))
        let out = URL(fileURLWithPath: try str("path"))
        let format = try str("format")
        let part = out.deletingLastPathComponent().appendingPathComponent(".\(out.lastPathComponent).part.\(format)")
        try? FileManager.default.removeItem(at: part)
        defer { try? FileManager.default.removeItem(at: part) }
        if format == "gif" { try gif(r, frames, fps, part, progress) } else { try mp4(r, frames, fps, part, progress) }
        try? FileManager.default.removeItem(at: out)
        try FileManager.default.moveItem(at: part, to: out)
    }

    /// Draws clip frames at the export size; `draw` returns BGRA rows, top-down, `w * 4` bytes each.
    final class Renderer {
        let w: Int, h: Int
        private let mesh: Mesh
        private let rect: [Float]
        private let queue: MTLCommandQueue
        private let pipeline: MTLRenderPipelineState
        private let sampler: MTLSamplerState
        private let msaa: MTLTexture, target: MTLTexture
        private let readback: MTLBuffer
        private let tex: MTLTexture
        private let pos: MTLBuffer, uv: MTLBuffer
        private let orders: [MTLBuffer]
        private let clear: MTLClearColor

        init(_ m: Mesh, _ texPath: String, _ w: Int, _ h: Int, _ rect: [Float], _ bg: UInt32) throws {
            guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else {
                throw MeshError(message: "Metal is not available")
            }
            (self.w, self.h, mesh, self.rect, queue) = (w, h, m, rect, q)
            let lib = try dev.makeLibrary(source: shaderSource, options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "mv_vertex")
            d.fragmentFunction = lib.makeFunction(name: "mv_fragment")
            d.rasterSampleCount = 4
            let c = d.colorAttachments[0]!
            c.pixelFormat = .bgra8Unorm
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
            guard let smp = dev.makeSamplerState(descriptor: s) else { throw MeshError(message: "Metal sampler failed") }
            sampler = smp
            let md = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
            md.textureType = .type2DMultisample
            md.sampleCount = 4
            md.usage = .renderTarget
            md.storageMode = .private
            let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
            td.usage = .renderTarget
            td.storageMode = .private
            guard let ms = dev.makeTexture(descriptor: md), let tg = dev.makeTexture(descriptor: td),
                  let rb = dev.makeBuffer(length: w * h * 4, options: .storageModeShared) else {
                throw MeshError(message: "cannot make a \(w)x\(h) render target")
            }
            (msaa, target, readback) = (ms, tg, rb)
            tex = try MTKTextureLoader(device: dev).newTexture(URL: URL(fileURLWithPath: texPath), options: [
                .SRGB: false, .origin: MTKTextureLoader.Origin.topLeft])
            guard let p = m.pos.withUnsafeBytes({ dev.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }),
                  let u = m.uv.withUnsafeBytes({ dev.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }) else {
                throw MeshError(message: "Metal buffer failed")
            }
            (pos, uv) = (p, u)
            orders = (0..<m.orders).compactMap { k in
                m.indices[k * m.indexCount..<(k + 1) * m.indexCount].withUnsafeBytes {
                    dev.makeBuffer(bytes: $0.baseAddress!, length: $0.count)
                }
            }
            clear = MTLClearColor(red: Double((bg >> 16) & 255) / 255, green: Double((bg >> 8) & 255) / 255,
                                  blue: Double(bg & 255) / 255, alpha: 1)
        }

        func draw(_ t: Int) throws -> UnsafeRawPointer {
            let pass = MTLRenderPassDescriptor()
            let a = pass.colorAttachments[0]!
            a.texture = msaa
            a.resolveTexture = target
            a.loadAction = .clear
            a.storeAction = .multisampleResolve
            a.clearColor = clear
            guard let cmd = queue.makeCommandBuffer(), let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else {
                throw MeshError(message: "Metal command buffer failed")
            }
            var u: [Float] = [rect[0], rect[1], rect[2], rect[3], Float(w), Float(h), 0, 0]
            enc.setRenderPipelineState(pipeline)
            enc.setVertexBuffer(pos, offset: t * mesh.vertices * 8, index: 0)
            enc.setVertexBuffer(uv, offset: 0, index: 1)
            enc.setVertexBytes(&u, length: u.count * 4, index: 2)
            enc.setFragmentTexture(tex, index: 0)
            enc.setFragmentSamplerState(sampler, index: 0)
            enc.drawIndexedPrimitives(type: .triangle, indexCount: mesh.indexCount, indexType: .uint16,
                                      indexBuffer: orders[Int(mesh.orderOfFrame[t])], indexBufferOffset: 0)
            enc.endEncoding()
            guard let blit = cmd.makeBlitCommandEncoder() else { throw MeshError(message: "Metal blit failed") }
            blit.copy(from: target, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                      sourceSize: MTLSize(width: w, height: h, depth: 1), to: readback, destinationOffset: 0,
                      destinationBytesPerRow: w * 4, destinationBytesPerImage: w * h * 4)
            blit.endEncoding()
            cmd.commit()
            cmd.waitUntilCompleted()
            if let e = cmd.error { throw MeshError(message: "Metal draw failed: \(e.localizedDescription)") }
            return UnsafeRawPointer(readback.contents())
        }
    }

    // MARK: MP4

    private static func mp4(_ r: Renderer, _ frames: [Int], _ fps: Double, _ url: URL,
                            _ progress: (Double) -> Void) throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: r.w,
            AVVideoHeightKey: r.h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(1_000_000, Int(Double(r.w * r.h) * fps * 0.2)),
                AVVideoMaxKeyFrameIntervalKey: max(1, Int(fps.rounded())),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: r.w,
            kCVPixelBufferHeightKey as String: r.h,
        ])
        guard writer.canAdd(input) else { throw MeshError(message: "cannot add an H.264 track") }
        writer.add(input)
        guard writer.startWriting() else {
            throw MeshError(message: "cannot start the MP4: \(writer.error?.localizedDescription ?? "unknown")")
        }
        writer.startSession(atSourceTime: .zero)
        let scale: Int32 = 90000
        for (k, t) in frames.enumerated() {
            let px = try r.draw(t)
            var waited = 0
            while !input.isReadyForMoreMediaData {
                if writer.status == .failed || waited > 2000 { break }
                usleep(5000)
                waited += 1
            }
            guard writer.status == .writing, let pool = adaptor.pixelBufferPool else {
                throw MeshError(message: "MP4 writer failed: \(writer.error?.localizedDescription ?? "not ready")")
            }
            var buf: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buf)
            guard let pb = buf else { throw MeshError(message: "no pixel buffer") }
            CVPixelBufferLockBaseAddress(pb, [])
            let dst = CVPixelBufferGetBaseAddress(pb)!, stride = CVPixelBufferGetBytesPerRow(pb)
            for y in 0..<r.h { memcpy(dst + y * stride, px + y * r.w * 4, r.w * 4) }
            CVPixelBufferUnlockBaseAddress(pb, [])
            let time = CMTime(value: CMTimeValue((Double(k) * Double(scale) / fps).rounded()), timescale: scale)
            guard adaptor.append(pb, withPresentationTime: time) else {
                throw MeshError(message: "MP4 writer failed: \(writer.error?.localizedDescription ?? "append")")
            }
            progress(Double(k + 1) / Double(frames.count) * 0.97)
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue((Double(frames.count) * Double(scale) / fps).rounded()),
                                               timescale: scale))
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        guard writer.status == .completed else {
            throw MeshError(message: "MP4 writer failed: \(writer.error?.localizedDescription ?? "unknown")")
        }
    }

    // MARK: GIF

    private static func gif(_ r: Renderer, _ frames: [Int], _ fps: Double, _ url: URL,
                            _ progress: (Double) -> Void) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString,
                                                         frames.count, nil) else {
            throw MeshError(message: "cannot write a GIF")
        }
        CGImageDestinationSetProperties(dest, [
            kCGImagePropertyGIFDictionary as String: [kCGImagePropertyGIFLoopCount as String: 0],
        ] as CFDictionary)
        let space = CGColorSpaceCreateDeviceRGB()
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        for (k, t) in frames.enumerated() {
            let px = try r.draw(t)
            let data = Data(bytes: px, count: r.w * r.h * 4)
            guard let provider = CGDataProvider(data: data as CFData),
                  let img = CGImage(width: r.w, height: r.h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: r.w * 4,
                                    space: space, bitmapInfo: info, provider: provider, decode: nil,
                                    shouldInterpolate: false, intent: .defaultIntent) else {
                throw MeshError(message: "cannot make a GIF frame")
            }
            let cs = max(2, Int((Double(k + 1) * 100 / fps).rounded()) - Int((Double(k) * 100 / fps).rounded()))
            CGImageDestinationAddImage(dest, img, [
                kCGImagePropertyGIFDictionary as String: [
                    kCGImagePropertyGIFDelayTime as String: Double(cs) / 100,
                    kCGImagePropertyGIFUnclampedDelayTime as String: Double(cs) / 100,
                ],
            ] as CFDictionary)
            progress(Double(k + 1) / Double(frames.count) * 0.95)
        }
        guard CGImageDestinationFinalize(dest) else { throw MeshError(message: "cannot finish the GIF") }
    }
}
