import Cocoa
import Foundation

NSApplication.shared.setActivationPolicy(.prohibited)
setbuf(stdout, nil)

func reply(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

// One request per line: a base64 script. One JSON reply per line.
while let line = readLine() {
    guard let data = Data(base64Encoded: line),
          let source = String(data: data, encoding: .utf8),
          let script = NSAppleScript(source: source) else {
        reply(["ok": false, "code": 0, "error": "bad request"])
        continue
    }
    var info: NSDictionary?
    let result = script.executeAndReturnError(&info)
    if let info = info {
        let code = (info[NSAppleScript.errorNumber] as? Int) ?? 0
        let message = (info[NSAppleScript.errorMessage] as? String) ?? "AppleScript error"
        reply(["ok": false, "code": code, "error": message])
    } else {
        reply(["ok": true, "out": result.stringValue ?? ""])
    }
}
