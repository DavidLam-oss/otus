import Cocoa
import CoreGraphics

func autoCleanIcon(inputPath: String, outputPath: String) {
    guard let srcImage = NSImage(contentsOfFile: inputPath),
          let tiff = srcImage.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let srcCg = rep.cgImage else {
        print("Error: cannot read image \(inputPath)")
        exit(1)
    }

    let w = srcCg.width
    let h = srcCg.height

    // 1. Scan for the squircle's silver/outer bezel
    // Looking from center (w/2, h/2) outwards along 4 directions to find outer edge of bezel
    let cx = w / 2
    let cy = h / 2

    // Sample background brightness at top-left corner
    let bgBrightness = rep.colorAt(x: 10, y: 10)?.brightnessComponent ?? 0.15

    var leftEdge = 0
    for x in 0..<cx {
        let b = rep.colorAt(x: x, y: cy)?.brightnessComponent ?? 0
        if b > bgBrightness + 0.18 || b > 0.4 {
            leftEdge = x
            break
        }
    }

    var rightEdge = w - 1
    for x in (cx..<w).reversed() {
        let b = rep.colorAt(x: x, y: cy)?.brightnessComponent ?? 0
        if b > bgBrightness + 0.18 || b > 0.4 {
            rightEdge = x
            break
        }
    }

    var topEdge = 0
    for y in 0..<cy {
        let b = rep.colorAt(x: cx, y: y)?.brightnessComponent ?? 0
        if b > bgBrightness + 0.18 || b > 0.4 {
            topEdge = y
            break
        }
    }

    var bottomEdge = h - 1
    for y in (cy..<h).reversed() {
        let b = rep.colorAt(x: cx, y: y)?.brightnessComponent ?? 0
        if b > bgBrightness + 0.18 || b > 0.4 {
            bottomEdge = y
            break
        }
    }

    // Fallbacks if detection is ambiguous
    if leftEdge <= 10 || rightEdge >= w - 10 {
        leftEdge = Int(Double(w) * 0.15)
        rightEdge = Int(Double(w) * 0.85)
    }
    if topEdge <= 10 || bottomEdge >= h - 10 {
        topEdge = Int(Double(h) * 0.15)
        bottomEdge = Int(Double(h) * 0.85)
    }

    let cropW = rightEdge - leftEdge
    let cropH = bottomEdge - topEdge
    let cropRect = CGRect(x: leftEdge, y: topEdge, width: cropW, height: cropH)

    guard let croppedCg = srcCg.cropping(to: cropRect) else {
        print("Error: Cropping failed")
        exit(1)
    }

    let canvasSize: CGFloat = 1024
    let targetSize: CGFloat = 824 // Standard Apple macOS Big Sur icon size
    let margin: CGFloat = (canvasSize - targetSize) / 2
    let cornerRadius: CGFloat = 185

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: Int(canvasSize),
        height: Int(canvasSize),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        print("Error: Context creation failed")
        exit(1)
    }

    ctx.clear(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))

    let iconRect = CGRect(x: margin, y: margin, width: targetSize, height: targetSize)
    let path = CGPath(roundedRect: iconRect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)

    // Subtle native drop shadow for elevation
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 20, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.3))
    ctx.addPath(path)
    ctx.setFillColor(CGColor(red: 0.05, green: 0.07, blue: 0.1, alpha: 1.0))
    ctx.fillPath()
    ctx.restoreGState()

    // Draw clipped squircle
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.draw(croppedCg, in: iconRect)
    ctx.restoreGState()

    guard let outCg = ctx.makeImage() else { exit(1) }
    let outRep = NSBitmapImageRep(cgImage: outCg)
    guard let pngData = outRep.representation(using: .png, properties: [:]) else { exit(1) }
    try? pngData.write(to: URL(fileURLWithPath: outputPath))
    print("Clean icon generated: \(outputPath)")
}

let args = CommandLine.arguments
if args.count < 3 {
    print("Usage: clean-icon <input> <output>")
    exit(1)
}
autoCleanIcon(inputPath: args[1], outputPath: args[2])
