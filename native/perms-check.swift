import Cocoa
import ApplicationServices

let prompt = CommandLine.arguments.contains("--prompt")

var screenGranted = CGPreflightScreenCaptureAccess()
if !screenGranted && prompt {
    screenGranted = CGRequestScreenCaptureAccess()
}

var axGranted = AXIsProcessTrusted()
if !axGranted && prompt {
    let options: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    axGranted = AXIsProcessTrustedWithOptions(options as CFDictionary)
}

print("{\"screenCapture\":\(screenGranted),\"accessibility\":\(axGranted)}")
if !screenGranted || !axGranted {
    exit(1)
} else {
    exit(0)
}
