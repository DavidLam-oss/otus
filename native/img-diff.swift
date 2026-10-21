import Cocoa
import CoreGraphics

// 缩略图尺寸：与 Alma 保持一致（160x90），
// 足够捕捉结构性变化，又把像素比对成本压到最低。
let THUMB_W = 160
let THUMB_H = 90

/// 生成 160x90 灰度缩略图的原始像素
func getThumbnail(path: String) -> [UInt8]? {
    guard let img = NSImage(contentsOfFile: path) else { return nil }
    guard let cgImage = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }

    let colorSpace = CGColorSpaceCreateDeviceGray()
    var rawData = [UInt8](repeating: 0, count: THUMB_W * THUMB_H)

    guard let ctx = CGContext(
        data: &rawData,
        width: THUMB_W,
        height: THUMB_H,
        bitsPerComponent: 8,
        bytesPerRow: THUMB_W,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return nil }

    ctx.interpolationQuality = .low
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: THUMB_W, height: THUMB_H))
    return rawData
}

/// 由缩略图计算 32-bin 归一化灰度直方图
func histogram32(_ pixels: [UInt8]) -> [Float] {
    var bins = [Float](repeating: 0, count: 32)
    for b in pixels {
        bins[Int(b >> 3)] += 1.0
    }
    let total = Float(pixels.count)
    if total > 0 {
        for i in 0..<32 { bins[i] /= total }
    }
    return bins
}

/// 32-bin 直方图巴氏距离（Bhattacharyya）
func bhattacharyyaDistance(_ h1: [Float], _ h2: [Float]) -> Float {
    var bc: Float = 0
    for i in 0..<32 {
        bc += sqrt(h1[i] * h2[i])
    }
    return sqrt(max(0, 1.0 - bc))
}

/// 像素级差异比例：逐像素比较灰度值，
/// 差值超过 tolerance 即记为「显著变化像素」。
/// 这一级用于过滤光标闪烁、时钟跳秒、抗锯齿抖动等局部微小变化。
func pixelDiffRatio(_ a: [UInt8], _ b: [UInt8], tolerance: Int) -> Float {
    guard a.count == b.count, a.count > 0 else { return 1.0 }
    var changed = 0
    for i in 0..<a.count {
        if abs(Int(a[i]) - Int(b[i])) > tolerance {
            changed += 1
        }
    }
    return Float(changed) / Float(a.count)
}

let args = CommandLine.arguments
if args.count < 3 {
    // 参数不足，无法判定，按「有变化」处理以保证不误丢数据
    exit(1)
}

let img1 = args[1]
let img2 = args[2]
// 直方图阈值（默认 0.05，与历史行为一致）
let histThreshold: Float = args.count >= 4 ? (Float(args[3]) ?? 0.05) : 0.05
// 像素差异比例阈值（默认 0.02，对齐 Alma pixelDiffThreshold）
let pixelThreshold: Float = args.count >= 5 ? (Float(args[4]) ?? 0.02) : 0.02
// 像素容差（默认 30，对齐 Alma pixelTolerance）
let pixelTolerance: Int = args.count >= 6 ? (Int(args[5]) ?? 30) : 30

guard let t1 = getThumbnail(path: img1),
      let t2 = getThumbnail(path: img2) else {
    // 读取失败按「有变化」处理
    exit(1)
}

// 第一级：直方图
let h1 = histogram32(t1)
let h2 = histogram32(t2)
let histDist = bhattacharyyaDistance(h1, h2)

if histDist >= histThreshold {
    // 整体亮度分布已明显不同，直接判定为变化，无需进入像素级比对
    print("changed:\(histDist)")
    exit(1)
}

// 第二级：像素级容差比对
let pixDiff = pixelDiffRatio(t1, t2, tolerance: pixelTolerance)
if pixDiff < pixelThreshold {
    print("duplicate:\(pixDiff)")
    exit(0)
} else {
    print("changed:\(pixDiff)")
    exit(1)
}
