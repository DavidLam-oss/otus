import Cocoa
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusTimer: Timer?
    var statusMenuItem: NSMenuItem!
    var settingsController: SettingsWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            if let icon = getStatusIcon() {
                button.image = icon
                button.imagePosition = .imageOnly
            } else {
                button.title = "Otus"
            }
            button.toolTip = "Otus 个人折腾日记"
        }

        buildMenu()
        updateStatus()

        // 每 30 秒自动刷新一次状态
        statusTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    private func getStatusIcon() -> NSImage? {
        let appBundle = Bundle.main.bundlePath
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(appBundle)/Contents/Resources/app/assets/menu-icon@2x.png",
            "\(home)/Documents/GitHub/otus/assets/menu-icon@2x.png",
            "\(appBundle)/Contents/Resources/app/assets/menu-icon.png",
            "\(home)/Documents/GitHub/otus/assets/menu-icon.png",
            "\(appBundle)/Contents/Resources/AppIcon.icns"
        ]
        for path in candidates {
            if FileManager.default.fileExists(atPath: path), let img = NSImage(contentsOfFile: path) {
                img.size = NSSize(width: 18, height: 18)
                img.isTemplate = true
                return img
            }
        }
        return nil
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
        statusMenuItem = NSMenuItem(title: "状态：检查中...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        statusMenuItem.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)
        menu.addItem(statusMenuItem)

        menu.addItem(NSMenuItem.separator())

        // 快捷操作
        let todayItem = NSMenuItem(title: "查看今日实时心流 (Today)", action: #selector(openToday), keyEquivalent: "t")
        todayItem.target = self
        todayItem.image = NSImage(systemSymbolName: "chart.bar", accessibilityDescription: nil)
        menu.addItem(todayItem)

        let yesterdayItem = NSMenuItem(title: "查看昨日折腾日记 (Yesterday)", action: #selector(openYesterday), keyEquivalent: "y")
        yesterdayItem.target = self
        yesterdayItem.image = NSImage(systemSymbolName: "calendar", accessibilityDescription: nil)
        menu.addItem(yesterdayItem)

        let folderItem = NSMenuItem(title: "打开报告归档目录 (Reports)...", action: #selector(openReportsFolder), keyEquivalent: "o")
        folderItem.target = self
        folderItem.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        menu.addItem(folderItem)

        menu.addItem(NSMenuItem.separator())

        let analyzeItem = NSMenuItem(title: "立即分析最新活动 (Analyze)", action: #selector(runAnalyze), keyEquivalent: "r")
        analyzeItem.target = self
        analyzeItem.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        menu.addItem(analyzeItem)

        menu.addItem(NSMenuItem.separator())

        let settingsItem = NSMenuItem(title: "偏好设置与模型配置...", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
        menu.addItem(settingsItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "退出 Otus (Quit)", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        quitItem.image = NSImage(systemSymbolName: "power", accessibilityDescription: nil)
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func updateStatus() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let pidPath = "\(home)/.otus/otus.pid"

        if FileManager.default.fileExists(atPath: pidPath),
           let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr), kill(pid, 0) == 0 {
            statusMenuItem.title = "状态：正常记录中 · PID \(pid)"
            statusMenuItem.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil)
        } else {
            statusMenuItem.title = "状态：守护进程待机中"
            statusMenuItem.image = NSImage(systemSymbolName: "pause.circle", accessibilityDescription: nil)
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

    @objc func openSettings() {
        if settingsController == nil {
            settingsController = SettingsWindowController()
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsController?.showWindow(nil)
        settingsController?.window?.makeKeyAndOrderFront(nil)
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

class SettingsWindowController: NSWindowController {
    var providerPopUp: NSPopUpButton!
    var urlField: NSTextField!
    var keyField: NSSecureTextField!
    var analysisField: NSTextField!
    var reportField: NSTextField!
    var statusLabel: NSTextField!

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 380),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Otus 偏好设置 · 大模型网关配置"
        window.center()
        self.init(window: window)
        setupUI()
        loadCurrentConfig()
    }

    private func setupUI() {
        guard let contentView = window?.contentView else { return }

        var y: CGFloat = 330
        let labelWidth: CGFloat = 120
        let fieldWidth: CGFloat = 320

        // 预设提供商下拉选择
        let pLabel = createLabel("服务提供商:", y: y, width: labelWidth)
        contentView.addSubview(pLabel)

        providerPopUp = NSPopUpButton(frame: NSRect(x: 140, y: y - 4, width: fieldWidth, height: 26))
        providerPopUp.addItems(withTitles: [
            "Magpie 本地网关 (默认推荐)",
            "DeepSeek 官方 API (高性价比推荐)",
            "Ollama 本地大模型 (100% 离线隐私)",
            "OpenAI 官方 API",
            "自定义兼容接口 (Custom)"
        ])
        providerPopUp.target = self
        providerPopUp.action = #selector(providerChanged)
        contentView.addSubview(providerPopUp)

        // API Base URL
        y -= 45
        contentView.addSubview(createLabel("API 接口地址:", y: y, width: labelWidth))
        urlField = NSTextField(frame: NSRect(x: 140, y: y, width: fieldWidth, height: 24))
        contentView.addSubview(urlField)

        // API Key
        y -= 40
        contentView.addSubview(createLabel("API 密钥 (Key):", y: y, width: labelWidth))
        keyField = NSSecureTextField(frame: NSRect(x: 140, y: y, width: fieldWidth, height: 24))
        contentView.addSubview(keyField)

        // Analysis Model
        y -= 40
        contentView.addSubview(createLabel("会话分析模型:", y: y, width: labelWidth))
        analysisField = NSTextField(frame: NSRect(x: 140, y: y, width: fieldWidth, height: 24))
        analysisField.placeholderString = "例如：group/fast-scan 或 deepseek-chat"
        analysisField.toolTip = "【白天高频微会话分析】推荐使用低延迟、低成本的轻量模型（如 deepseek-chat、gpt-4o-mini、qwen2.5:7b 或 Magpie 的 group/fast-scan），每次分析仅耗时数百毫秒。"
        contentView.addSubview(analysisField)

        // Report Model
        y -= 40
        contentView.addSubview(createLabel("深度复盘模型:", y: y, width: labelWidth))
        reportField = NSTextField(frame: NSRect(x: 140, y: y, width: fieldWidth, height: 24))
        reportField.placeholderString = "例如：group/smart-router 或 gpt-4o"
        reportField.toolTip = "【晚间全天日记深度复盘】推荐使用具备复杂上下文推理与代码理解能力的旗舰模型（如 claude-3-7-sonnet、gpt-4o、deepseek-chat 或 Magpie 的 group/smart-router），能够提炼全天技术攻坚脉络与代码决策。"
        contentView.addSubview(reportField)

        // 说明提示
        y -= 26
        let tipLabel = NSTextField(frame: NSRect(x: 140, y: y, width: fieldWidth, height: 18))
        tipLabel.stringValue = "💡 单一平台（如 DeepSeek/OpenAI/Ollama）两个模型共用相同 API 地址与 Key"
        tipLabel.isBezeled = false
        tipLabel.isEditable = false
        tipLabel.drawsBackground = false
        tipLabel.font = NSFont.systemFont(ofSize: 10.5)
        tipLabel.textColor = .secondaryLabelColor
        contentView.addSubview(tipLabel)

        // Status Label (连接测试状态反馈)
        y -= 24
        statusLabel = NSTextField(frame: NSRect(x: 140, y: y, width: fieldWidth, height: 20))
        statusLabel.isBezeled = false
        statusLabel.isEditable = false
        statusLabel.drawsBackground = false
        statusLabel.font = NSFont.systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        contentView.addSubview(statusLabel)

        // 按钮区域
        y -= 40
        let testBtn = NSButton(frame: NSRect(x: 140, y: y, width: 100, height: 28))
        testBtn.title = "测试连接"
        testBtn.bezelStyle = .rounded
        testBtn.target = self
        testBtn.action = #selector(testConnection)
        contentView.addSubview(testBtn)

        let cancelBtn = NSButton(frame: NSRect(x: 275, y: y, width: 85, height: 28))
        cancelBtn.title = "取消"
        cancelBtn.bezelStyle = .rounded
        cancelBtn.target = self
        cancelBtn.action = #selector(cancelAction)
        contentView.addSubview(cancelBtn)

        let saveBtn = NSButton(frame: NSRect(x: 365, y: y, width: 95, height: 28))
        saveBtn.title = "保存生效"
        saveBtn.bezelStyle = .rounded
        saveBtn.keyEquivalent = "\r"
        saveBtn.target = self
        saveBtn.action = #selector(saveSettings)
        contentView.addSubview(saveBtn)
    }

    private func createLabel(_ text: String, y: CGFloat, width: CGFloat) -> NSTextField {
        let label = NSTextField(frame: NSRect(x: 10, y: y + 2, width: width, height: 20))
        label.stringValue = text
        label.isBezeled = false
        label.isEditable = false
        label.drawsBackground = false
        label.alignment = .right
        label.font = NSFont.systemFont(ofSize: 12)
        label.textColor = .labelColor
        return label
    }

    @objc private func providerChanged() {
        let idx = providerPopUp.indexOfSelectedItem
        switch idx {
        case 0: // Magpie
            urlField.stringValue = "http://127.0.0.1:3425/v1"
            keyField.stringValue = "magpie-local"
            analysisField.stringValue = "group/fast-scan"
            reportField.stringValue = "group/smart-router"
        case 1: // DeepSeek
            urlField.stringValue = "https://api.deepseek.com/v1"
            if keyField.stringValue == "magpie-local" || keyField.stringValue == "ollama" { keyField.stringValue = "" }
            analysisField.stringValue = "deepseek-chat"
            reportField.stringValue = "deepseek-chat"
        case 2: // Ollama
            urlField.stringValue = "http://127.0.0.1:11434/v1"
            keyField.stringValue = "ollama"
            analysisField.stringValue = "qwen2.5:7b"
            reportField.stringValue = "qwen2.5:14b"
        case 3: // OpenAI
            urlField.stringValue = "https://api.openai.com/v1"
            if keyField.stringValue == "magpie-local" || keyField.stringValue == "ollama" { keyField.stringValue = "" }
            analysisField.stringValue = "gpt-4o-mini"
            reportField.stringValue = "gpt-4o"
        default:
            break
        }
    }

    private func loadCurrentConfig() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let configPath = "\(home)/.otus/config.json"
        var url = "http://127.0.0.1:3425/v1"
        var key = "magpie-local"
        var analysis = "group/fast-scan"
        var report = "group/smart-router"

        if let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let u = json["llmApiBase"] as? String { url = u }
            if let k = json["llmApiKey"] as? String { key = k }
            if let a = json["analysisModel"] as? String { analysis = a }
            if let r = json["reportModel"] as? String { report = r }
        }

        urlField.stringValue = url
        keyField.stringValue = key
        analysisField.stringValue = analysis
        reportField.stringValue = report

        if url.contains("127.0.0.1:3425") {
            providerPopUp.selectItem(at: 0)
        } else if url.contains("deepseek.com") {
            providerPopUp.selectItem(at: 1)
        } else if url.contains("11434") {
            providerPopUp.selectItem(at: 2)
        } else if url.contains("openai.com") {
            providerPopUp.selectItem(at: 3)
        } else {
            providerPopUp.selectItem(at: 4)
        }
    }

    @objc private func testConnection() {
        statusLabel.stringValue = "正在测试连接..."
        statusLabel.textColor = .secondaryLabelColor

        let urlStr = urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let keyStr = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let url = URL(string: "\(urlStr)/models") else {
            statusLabel.stringValue = "✕ API 地址无效"
            statusLabel.textColor = .systemRed
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 4.0
        if !keyStr.isEmpty {
            req.setValue("Bearer \(keyStr)", forHTTPHeaderField: "Authorization")
        }

        URLSession.shared.dataTask(with: req) { _, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self.statusLabel.stringValue = "✕ 连接失败: \(error.localizedDescription)"
                    self.statusLabel.textColor = .systemRed
                    return
                }
                if let http = response as? HTTPURLResponse {
                    if (200...299).contains(http.statusCode) {
                        self.statusLabel.stringValue = "✓ 连接成功 (HTTP \(http.statusCode))"
                        self.statusLabel.textColor = .systemGreen
                    } else {
                        self.statusLabel.stringValue = "✕ 响应异常 (HTTP \(http.statusCode))"
                        self.statusLabel.textColor = .systemRed
                    }
                }
            }
        }.resume()
    }

    @objc private func cancelAction() {
        self.window?.close()
    }

    @objc private func saveSettings() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let dir = "\(home)/.otus"
        let configPath = "\(dir)/config.json"

        var dict: [String: Any] = [:]
        if let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            dict = existing
        }

        dict["llmApiBase"] = urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        dict["llmApiKey"] = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        dict["analysisModel"] = analysisField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        dict["reportModel"] = reportField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        if let outData = try? JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted) {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? outData.write(to: URL(fileURLWithPath: configPath))
        }

        self.window?.close()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
