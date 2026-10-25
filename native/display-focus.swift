import Cocoa
import ApplicationServices

// otus-display-focus：多屏场景下判定「用户此刻在操作哪块屏」，输出该屏的 screencapture -D 编号。
//
// 设计原则（与 window-title.swift 一致，绝不做后台轮询）：
//   - 本进程是一次性短命进程，由 recorder 在「即将截图」时才 spawn 一次，
//     天然被去抖到 ≥4s，AX 跨进程 IPC 调用次数压到与截图同频。
//   - 输入：无（也可用 --pid <pid> 显式指定目标 App）。
//   - 输出：一行 JSON 到 stdout，形如
//       {"ok":true,"display":2,"screens":2,"totalWidth":4030,"source":"ax","screenWidth":2560,"screenHeight":1440}
//     display 即 screencapture -D 的编号（1 起，NSScreen.screens 顺序）。
//
// 关键判定链（这是本文件的核心，顺序不能反）：
//   ① 单屏：直接返回 -D1，不做任何 AX 调用（保持现有单屏性能与行为完全不变）。
//   ② 焦点窗口：NSWorkspace.frontmostApplication.pid → kAXFocusedWindowAttribute
//      → kAXPositionAttribute + kAXSizeAttribute → 窗口中心点 → 命中哪块 NSScreen。
//      为什么用"中心点"而不是"origin"：窗口跨屏时 origin 可能落在另一块屏上，
//      而用户实际在看的、窗口主体所在的那块屏由中心点决定。
//   ③ 回退鼠标：AX 不可用（无辅助功能权限 / App 无标准 AX 窗口 / 焦点窗口取不到位置）
//      时，用 NSEvent.mouseLocation 命中哪块屏幕。
//   ④ 最终回退：-D1（主屏）。
//
// 坐标系陷阱（踩过）：
//   - NSScreen.frame 与 NSEvent.mouseLocation 都是 Cocoa 坐标（原点在主屏左下，Y 向上），
//     可以直接 contains()。
//   - AX 返回的 kAXPositionAttribute 坐标是**左上原点、Y 向下**的全局屏幕坐标，
//     与 CGDisplayBounds 同一坐标系；不能直接拿去和 NSScreen.frame 比较，
//     必须先换算成 Cocoa 坐标（见 axRectToCocoa）。
//   - NSScreen.screens 的顺序就是 screencapture -D 的编号顺序（实测：-D1 为主屏），
//     但 CGGetActiveDisplayList 的顺序与之不同，故这里只用 NSScreen.screens。

func jsonEscape(_ s: String) -> String {
    var out = ""
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

let screens = NSScreen.screens
let screenCount = screens.count
let totalWidth = screens.reduce(0.0) { $0 + $1.frame.width }

// ① 单屏快速路径：不碰 AX，直接 -D1
if screenCount <= 1 {
    let s = screens.first
    reply([
        "ok": true,
        "display": 1,
        "screens": screenCount,
        "totalWidth": Int(totalWidth.rounded()),
        "source": "single",
        "screenWidth": Int((s?.frame.width ?? 0).rounded()),
        "screenHeight": Int((s?.frame.height ?? 0).rounded()),
    ])
    exit(0)
}

/// 命中测试：点落在哪块 NSScreen 上，返回 1 起的 -D 编号；都不命中返回 nil。
/// 注意：跨屏边界时用 contains 判定，主屏坐标原点在 (0,0) 且副屏可能为负坐标。
func displayIndex(forCocoaPoint p: NSPoint) -> Int? {
    // 先精确命中
    for (i, s) in screens.enumerated() where s.frame.contains(p) {
        return i + 1
    }
    // 浮点边界（正好落在两屏接缝）时按最近中心点兜底，避免因 0.5pt 误差回退到主屏
    var best: (idx: Int, dist: CGFloat) = (0, .infinity)
    for (i, s) in screens.enumerated() {
        let c = NSPoint(x: s.frame.midX, y: s.frame.midY)
        let d = hypot(p.x - c.x, p.y - c.y)
        if d < best.dist { best = (i + 1, d) }
    }
    return best.dist.isFinite ? best.idx : nil
}

/// AX 窗口矩形（左上原点、Y 向下）→ Cocoa 全局坐标（左下原点、Y 向上）。
/// 换算基准：主屏顶部 = Cocoa 坐标系里的 maxY。
/// Cocoa: y = (主屏frame.maxY) - (axY + axH)
func axRectToCocoa(_ rect: CGRect) -> CGRect {
    guard let mainScreen = NSScreen.screens.first else { return rect }
    let flippedY = mainScreen.frame.maxY - (rect.origin.y + rect.height)
    return CGRect(x: rect.origin.x, y: flippedY, width: rect.width, height: rect.height)
}

/// 取某个 pid 的焦点窗口在 Cocoa 坐标系下的 frame。取不到返回 nil。
func focusedWindowCocoaFrame(pid: pid_t) -> CGRect? {
    let appElem = AXUIElementCreateApplication(pid)

    var focusedWindow: AnyObject?
    var win: AXUIElement?
    if AXUIElementCopyAttributeValue(appElem, kAXFocusedWindowAttribute as CFString, &focusedWindow) == .success {
        win = (focusedWindow as! AXUIElement)
    } else {
        // 焦点窗口拿不到时退主窗口（部分 App 焦点窗口未设置但主窗口有效）
        var mainWindow: AnyObject?
        if AXUIElementCopyAttributeValue(appElem, kAXMainWindowAttribute as CFString, &mainWindow) == .success {
            win = (mainWindow as! AXUIElement)
        }
    }
    guard let element = win else { return nil }

    var posVal: AnyObject?
    var sizeVal: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posVal) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeVal) == .success else {
        return nil
    }

    var pos = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posVal as! AXValue, .cgPoint, &pos),
          AXValueGetValue(sizeVal as! AXValue, .cgSize, &size),
          size.width > 0, size.height > 0 else {
        return nil
    }

    return axRectToCocoa(CGRect(origin: pos, size: size))
}

// ② 焦点窗口 → 屏幕
if let front = NSWorkspace.shared.frontmostApplication {
    let pid = front.processIdentifier
    if AXIsProcessTrusted(), let cocoaRect = focusedWindowCocoaFrame(pid: pid) {
        // 判定点：窗口中心。跨屏窗口时，用户主要在看的那块屏由中心点决定。
        let center = NSPoint(x: cocoaRect.midX, y: cocoaRect.midY)
        if let idx = displayIndex(forCocoaPoint: center) {
            let s = screens[idx - 1]
            reply([
                "ok": true,
                "display": idx,
                "screens": screenCount,
                "totalWidth": Int(totalWidth.rounded()),
                "source": "ax",
                "bundleId": jsonEscape(front.bundleIdentifier ?? ""),
                "appName": jsonEscape(front.localizedName ?? ""),
                "screenWidth": Int(s.frame.width.rounded()),
                "screenHeight": Int(s.frame.height.rounded()),
            ])
            exit(0)
        }
    }
}

// ③ 回退鼠标所在屏
let mouse = NSEvent.mouseLocation
if let idx = displayIndex(forCocoaPoint: mouse) {
    let s = screens[idx - 1]
    reply([
        "ok": true,
        "display": idx,
        "screens": screenCount,
        "totalWidth": Int(totalWidth.rounded()),
        "source": "mouse",
        "screenWidth": Int(s.frame.width.rounded()),
        "screenHeight": Int(s.frame.height.rounded()),
    ])
    exit(0)
}

// ④ 最终回退主屏
reply([
    "ok": false,
    "display": 1,
    "screens": screenCount,
    "totalWidth": Int(totalWidth.rounded()),
    "source": "fallback",
    "screenWidth": Int((screens.first?.frame.width ?? 0).rounded()),
    "screenHeight": Int((screens.first?.frame.height ?? 0).rounded()),
])
