import Cocoa
import Foundation

setbuf(stdout, nil)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

func jsonEscape(_ s: String) -> String {
    return s
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
}

func frontmostBundleId() -> String {
    return NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
}
func frontmostName() -> String {
    return NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
}

func emit(_ payload: String) {
    print(payload)
}

// Clicks
NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
    let loc = NSEvent.mouseLocation
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    let button = event.type == .leftMouseDown ? "left" : "right"
    let bundle = jsonEscape(frontmostBundleId())
    let appName = jsonEscape(frontmostName())
    emit("{\"type\":\"click\",\"button\":\"\(button)\",\"x\":\(Int(loc.x)),\"y\":\(Int(loc.y)),\"timestamp\":\(ts),\"bundleId\":\"\(bundle)\",\"appName\":\"\(appName)\"}")
}

// Keys
NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { event in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    let modifiers = event.modifierFlags.rawValue
    let bundle = jsonEscape(frontmostBundleId())
    let appName = jsonEscape(frontmostName())
    emit("{\"type\":\"keypress\",\"keyCode\":\(event.keyCode),\"modifiers\":\(modifiers),\"timestamp\":\(ts),\"bundleId\":\"\(bundle)\",\"appName\":\"\(appName)\"}")
}

// App focus changes
let nc = NSWorkspace.shared.notificationCenter
nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { note in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    guard let nsApp = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    let bundle = jsonEscape(nsApp.bundleIdentifier ?? "")
    let appName = jsonEscape(nsApp.localizedName ?? "")
    emit("{\"type\":\"app_focus\",\"timestamp\":\(ts),\"bundleId\":\"\(bundle)\",\"appName\":\"\(appName)\"}")
}

// Lock / unlock via distributed notifications
let dnc = DistributedNotificationCenter.default()
dnc.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: nil) { _ in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    emit("{\"type\":\"lock\",\"timestamp\":\(ts)}")
}
dnc.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: nil) { _ in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    emit("{\"type\":\"unlock\",\"timestamp\":\(ts)}")
}

// System Sleep & Wake (Clamshell / lid close / sleep timer)
nc.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    emit("{\"type\":\"sleep\",\"timestamp\":\(ts)}")
}
nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    emit("{\"type\":\"wake\",\"timestamp\":\(ts)}")
}
nc.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: nil) { _ in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    emit("{\"type\":\"screens_sleep\",\"timestamp\":\(ts)}")
}
nc.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: nil) { _ in
    let ts = Int(Date().timeIntervalSince1970 * 1000)
    emit("{\"type\":\"screens_wake\",\"timestamp\":\(ts)}")
}

app.run()
