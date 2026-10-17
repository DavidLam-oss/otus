import Vision
import ImageIO
import Foundation

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: ocr <image_path> [languages]\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let languages: [String] = CommandLine.arguments.count > 2
    ? CommandLine.arguments[2].components(separatedBy: ",")
    : ["zh-Hans", "en-US"]

guard let imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
    fputs("Error: Could not load image at \(imagePath)\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = languages
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("OCR error: \(error)\n", stderr)
    exit(1)
}

for observation in request.results ?? [] {
    if let candidate = observation.topCandidates(1).first {
        print(candidate.string)
    }
}
