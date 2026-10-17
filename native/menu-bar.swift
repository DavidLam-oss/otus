import Cocoa
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusTimer: Timer?
    var statusMenuItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🦉"
            button.toolTip = "Otus 个人折腾日记"
        }

        buildMenu()
        updateStatus()

        // 每 30 秒自动刷新一次状态
        statusTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    private func getOtusBin() -> String {
        let appBundlePath = Bundle.main.bundlePath
        let inAppBin = "\(appBundlePath)/Contents/Resources/app/bin/otus"
        if FileManager.default.fileExists(atPath: inAppBin) {
            return inAppBin
        }
        let fallback = "/Applications/Otus.app/Contents/Resources/app/bin/otus"
        if FileManager.default.fileExists(atPath: fallback) {
            return fallback
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Documents/GitHub/otus/bin/otus"
    }

    private func buildMenu() {
        let menu = NSMenu()

        // 标题行
        let titleItem = NSMenuItem(title: "Otus 个人折腾日记", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        // 动态状态行
        statusMenuItem = NSMenuItem(title: "🟢 守护进程运行中", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        menu.addItem(NSMenuItem.separator())

        // 快捷操作
        let todayItem = NSMenuItem(title: "📊 查看今日实时心流 (Today)", action: #selector(openToday), keyEquivalent: "t")
        todayItem.target = self
        menu.addItem(todayItem)

        let yesterdayItem = NSMenuItem(title: "📅 查看昨日折腾日记 (Yesterday)", action: #selector(openYesterday), keyEquivalent: "y")
        yesterdayItem.target = self
        menu.addItem(yesterdayItem)

        let folderItem = NSMenuItem(title: "📂 打开报告归档目录 (Reports)...", action: #selector(openReportsFolder), keyEquivalent: "o")
        folderItem.target = self
        menu.addItem(folderItem)

        menu.addItem(NSMenuItem.separator())

        let analyzeItem = NSMenuItem(title: "🔄 立即分析会话 (Analyze)", action: #selector(runAnalyze), keyEquivalent: "r")
        analyzeItem.target = self
        menu.addItem(analyzeItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "🚪 退出 Otus (Quit)", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func updateStatus() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let pidPath = "\(home)/.otus/otus.pid"

        if FileManager.default.fileExists(atPath: pidPath),
           let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr), kill(pid, 0) == 0 {
            statusMenuItem.title = "🟢 正常记录中 · PID \(pid)"
        } else {
            statusMenuItem.title = "⚪️ 守护进程待机中"
        }
    }

    @objc func openToday() {
        let bin = getOtusBin()
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: bin)
            task.arguments = ["export"]
            try? task.run()
        }
    }

    @objc func openYesterday() {
        let bin = getOtusBin()
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: bin)
            task.arguments = ["export", "yesterday"]
            try? task.run()
        }
    }

    @objc func openReportsFolder() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let dir = "\(home)/.otus/reports"
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    @objc func runAnalyze() {
        let bin = getOtusBin()
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: bin)
            task.arguments = ["analyze"]
            try? task.run()
        }
    }

    @objc func quitApp() {
        let bin = getOtusBin()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: bin)
        task.arguments = ["stop"]
        try? task.run()
        task.waitUntilExit()

        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
