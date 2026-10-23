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

// ===== 前台 App 定期采样（方案 A：长任务期间保持 App 归属）=====
// 动机：人不操作时不会有 app_focus 事件，frontmost 会滞留旧值/空值，
// 导致新建 session 的 app_names 为空。这里定时采样 NSWorkspace.frontmostApplication，
// 仅当与上次采样值不同时才 emit 一条 via:"poll" 的 app_focus，避免无谓刷事件。
// 间隔由 Node 侧通过第一个命令行参数传入（毫秒），缺省 30000。
var lastPolledBundleId: String = ""
var lastPolledAppName: String = ""
let pollIntervalMs: Int = {
    if CommandLine.arguments.count >= 2, let v = Int(CommandLine.arguments[1]), v >= 1000 {
        return v
    }
    return 30000
}()

func pollFrontmostOnce() {
    let bundle = frontmostBundleId()
    let appName = frontmostName()
    if bundle != lastPolledBundleId || appName != lastPolledAppName {
        if !appName.isEmpty && appName != "otus-input-monitor" {
            let ts = Int(Date().timeIntervalSince1970 * 1000)
            let b = jsonEscape(bundle)
            let a = jsonEscape(appName)
            emit("{\"type\":\"app_focus\",\"timestamp\":\(ts),\"bundleId\":\"\(b)\",\"appName\":\"\(a)\",\"via\":\"poll\"}")
        }
        lastPolledBundleId = bundle
        lastPolledAppName = appName
    }
}

let pollTimer = Timer.scheduledTimer(withTimeInterval: Double(pollIntervalMs) / 1000.0, repeats: true) { _ in
    pollFrontmostOnce()
}
RunLoop.main.add(pollTimer, forMode: .common)

// 启动后 500ms 立即采样一次，避免 daemon 刚起来时 frontmost 为空导致首批会话丢归属
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    pollFrontmostOnce()
}

app.run()
