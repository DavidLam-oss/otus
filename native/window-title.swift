import Cocoa
import Foundation
import ApplicationServices

// otus-window-title：按需取「前台焦点窗口标题」的极小辅助进程。
//
// 设计原则（性能优先，绝不做后台轮询）：
//   - 本进程不自己定时抓取，而是 stdin 每行一个请求，stdout 每行一个 JSON 回复。
//   - 父进程（recorder）只在「即将截图」时才发一次请求，天然被去抖到 ≥4s，
//     AX 跨进程 IPC 调用次数被压到与截图同频，不破坏 40MB / 0%CPU 目标。
//   - 请求格式：一行 JSON，可为 {"pid":123} 或 {"bundleId":"com.x"} 或 {}（取当前前台 App）。
//   - 回复格式：一行 JSON {"ok":true,"title":"...","bundleId":"..."} 或 {"ok":false,"error":"..."}
//
// 为什么用长驻 stdin/stdout 而不是每次 spawn：
//   spawn 一个进程 + AX 连接建立约 20~50ms，若每次截图都 spawn 太浪费；
//   长驻一个空转进程（无事件循环、阻塞在 readLine）内存 ~3MB、CPU 0%。

setbuf(stdout, nil)

// 辅助功能权限：没有就直接回错误，不反复尝试（避免刷屏）
// 若以 --prompt 启动，则主动触发系统授权弹窗，把本二进制登记进「辅助功能」列表。
if CommandLine.arguments.contains("--prompt") {
    let options: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
}
let axTrusted = AXIsProcessTrusted()

func jsonEscape(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count)
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\\": out += "\\\\"
        case "\"": out += "\\\""
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

func reply(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

// 取某个 pid 的焦点窗口标题。返回 nil 表示取不到（无窗口 / 无权限 / 该 App 不支持）。
func focusedWindowTitle(pid: pid_t) -> String? {
    let appElem = AXUIElementCreateApplication(pid)

    var focusedWindow: AnyObject?
    let winResult = AXUIElementCopyAttributeValue(appElem, kAXFocusedWindowAttribute as CFString, &focusedWindow)
    guard winResult == .success, let window = focusedWindow else {
        // 有些 App 没有"焦点窗口"，退而求其次用主窗口
        var mainWindow: AnyObject?
        let mainResult = AXUIElementCopyAttributeValue(appElem, kAXMainWindowAttribute as CFString, &mainWindow)
        guard mainResult == .success, let w = mainWindow else { return nil }
        var titleVal: AnyObject?
        guard AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &titleVal) == .success,
              let title = titleVal as? String else { return nil }
        return title
    }

    var titleVal: AnyObject?
    guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleVal) == .success,
          let title = titleVal as? String else { return nil }
    return title
}

// 主循环：每行一个请求，同步处理、同步回复。
while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }

    // 解析请求（容错：非 JSON 就当空请求处理）
    var reqPid: pid_t? = nil
    var reqBundle: String? = nil
    if let data = trimmed.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        if let p = obj["pid"] as? Int { reqPid = pid_t(p) }
        if let b = obj["bundleId"] as? String, !b.isEmpty { reqBundle = b }
    }

    if !axTrusted {
        reply(["ok": false, "error": "accessibility_not_granted"])
        continue
    }

    // 确定目标 pid：显式 pid > bundleId 查前台匹配 > 当前前台 App
    var pid: pid_t? = reqPid
    if pid == nil, let bundle = reqBundle {
        // 在运行中的 App 里找 bundleId 匹配的（优先前台）
        if let front = NSWorkspace.shared.frontmostApplication,
           front.bundleIdentifier == bundle {
            pid = front.processIdentifier
        } else {
            for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == bundle {
                pid = app.processIdentifier
                break
            }
        }
    }
    if pid == nil {
        pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
    guard let targetPid = pid else {
        reply(["ok": false, "error": "no_frontmost_app"])
        continue
    }

    let bundleId = NSWorkspace.shared.runningApplications
        .first(where: { $0.processIdentifier == targetPid })?.bundleIdentifier ?? ""

    if let title = focusedWindowTitle(pid: targetPid) {
        reply(["ok": true, "title": title, "bundleId": bundleId])
    } else {
        // 取不到标题是常态（部分 App 无窗口/标题为空），回空标题但 ok=true 便于区分"能取但空"
        reply(["ok": true, "title": "", "bundleId": bundleId])
    }
}
