import Cocoa
import CoreGraphics

func get32BinHistogram(path: String) -> [Float]? {
    guard let img = NSImage(contentsOfFile: path) else { return nil }
    guard let cgImage = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    
    let width = 160
    let height = 100
    let colorSpace = CGColorSpaceCreateDeviceGray()
    var rawData = [UInt8](repeating: 0, count: width * height)
    
    guard let ctx = CGContext(
        data: &rawData,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return nil }
    
    ctx.interpolationQuality = .low
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    
    var bins = [Float](repeating: 0, count: 32)
    let total = Float(width * height)
    for b in rawData {
        let binIdx = Int(b >> 3)
        bins[binIdx] += 1.0
    }
    for i in 0..<32 {
        bins[i] /= total
    }
    return bins
}

func bhattacharyyaDistance(_ h1: [Float], _ h2: [Float]) -> Float {
    var bc: Float = 0
    for i in 0..<32 {
        bc += sqrt(h1[i] * h2[i])
    }
    return sqrt(max(0, 1.0 - bc))
}

let args = CommandLine.arguments
if args.count < 3 {
    // Insufficient args, assume not duplicate
    exit(1)
}

let img1 = args[1]
let img2 = args[2]
let threshold: Float = args.count >= 4 ? (Float(args[3]) ?? 0.05) : 0.05

guard let h1 = get32BinHistogram(path: img1),
      let h2 = get32BinHistogram(path: img2) else {
    // If reading fails, assume different
    exit(1)
}

let dist = bhattacharyyaDistance(h1, h2)
if dist < threshold {
    // 0 means DUPLICATE (below change threshold)
    print("duplicate:\(dist)")
    exit(0)
} else {
    // 1 means SIGNIFICANT CHANGE
    print("changed:\(dist)")
    exit(1)
}
