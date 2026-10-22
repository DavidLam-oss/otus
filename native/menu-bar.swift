import Cocoa
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusTimer: Timer?
    var statusMenuItem: NSMenuItem!
    var todayMenuItem: NSMenuItem!
    var analyzeMenuItem: NSMenuItem!
    var settingsController: SettingsWindowController?
    // 任务进行中标志：进行中时菜单栏显示进度、禁止重复触发
    var busyTask: String? = nil
    var spinnerTimer: Timer?
    var spinnerFrames = ["◐", "◓", "◑", "◒"]
    var spinnerIndex = 0

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
        let todayItem = NSMenuItem(title: "生成今日报告 (Today)", action: #selector(openToday), keyEquivalent: "t")
        todayItem.target = self
        todayItem.image = NSImage(systemSymbolName: "chart.bar", accessibilityDescription: nil)
        menu.addItem(todayItem)
        self.todayMenuItem = todayItem

        let yesterdayItem = NSMenuItem(title: "查看昨日折腾日记 (Yesterday)", action: #selector(openYesterday), keyEquivalent: "y")
        yesterdayItem.target = self
        yesterdayItem.image = NSImage(systemSymbolName: "calendar", accessibilityDescription: nil)
        menu.addItem(yesterdayItem)

        let folderItem = NSMenuItem(title: "打开报告归档目录 (Reports)...", action: #selector(openReportsFolder), keyEquivalent: "o")
        folderItem.target = self
        folderItem.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        menu.addItem(folderItem)

        menu.addItem(NSMenuItem.separator())

        let analyzeItem = NSMenuItem(title: "补齐未分析会话 (Analyze)", action: #selector(runAnalyze), keyEquivalent: "r")
        analyzeItem.target = self
        analyzeItem.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        menu.addItem(analyzeItem)
        self.analyzeMenuItem = analyzeItem

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

    // MARK: - 任务进度反馈
    // 生成报告需要多次调用大模型（补齐分析 + 主题归纳 + 洞察 + 润色），
    // 期间可能十几秒没有反应。用图标跑马灯 + 菜单项文字变化给出明确反馈，
    // 避免用户以为点击没生效而反复点击。

    private func beginBusy(_ label: String) {
        busyTask = label
        statusItem.button?.title = ""
        spinnerIndex = 0
        // 图标区显示跑马灯
        if let button = statusItem.button {
            button.image = nil
            button.imagePosition = .noImage
            button.title = spinnerFrames[0]
            button.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        }
        // 菜单里对应的项改为「进行中…」并禁用以防重复触发
        todayMenuItem?.isEnabled = false
        analyzeMenuItem?.isEnabled = false
        statusMenuItem.title = "状态：\(label)…"
        statusMenuItem.image = NSImage(systemSymbolName: "hourglass", accessibilityDescription: nil)

        spinnerTimer?.invalidate()
        spinnerTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.spinnerIndex = (self.spinnerIndex + 1) % self.spinnerFrames.count
            self.statusItem.button?.title = self.spinnerFrames[self.spinnerIndex]
        }
    }

    private func endBusy(success: Bool, message: String) {
        busyTask = nil
        spinnerTimer?.invalidate()
        spinnerTimer = nil
        // 恢复图标
        if let button = statusItem.button {
            button.title = ""
            if let icon = getStatusIcon() {
                button.image = icon
                button.imagePosition = .imageOnly
            } else {
                button.title = "Otus"
            }
        }
        todayMenuItem?.isEnabled = true
        analyzeMenuItem?.isEnabled = true

        // 系统通知：任务完成/失败时给出明确结果
        // 用 NSUserNotification 而非 UserNotifications：菜单栏以裸二进制
        // 方式运行、没有 .app bundle，UNUserNotificationCenter 会因取不到
        // 通知中心而抛异常崩溃（实测 SIGABRT）。NSUserNotification 虽已废弃
        // 但在该场景稳定可用。
        let alert = NSUserNotification()
        alert.title = success ? "Otus" : "Otus 出错了"
        alert.informativeText = message
        if !success { alert.soundName = NSUserNotificationDefaultSoundName }
        NSUserNotificationCenter.default.deliver(alert)

        updateStatus()
    }

    /// 运行 otus 子命令，实时读取 stderr 里的 PROGRESS 行更新菜单状态。
    private func runOtusTask(label: String, arguments: [String], completion: @escaping (Bool, String) -> Void) {
        guard busyTask == nil else { return }
        beginBusy(label)

        let bin = getOtusBin()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let task = Process()
            task.executableURL = URL(fileURLWithPath: bin)
            task.arguments = arguments

            let pipe = Pipe()
            task.standardError = pipe
            task.standardOutput = Pipe()

            // 逐行读取 stderr，遇到 PROGRESS 前缀就更新菜单文案
            var lastLine = ""
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                for raw in text.split(separator: "\n") {
                    let line = String(raw).trimmingCharacters(in: .whitespaces)
                    if line.hasPrefix("PROGRESS ") {
                        let msg = String(line.dropFirst("PROGRESS ".count))
                        lastLine = msg
                        DispatchQueue.main.async {
                            self?.statusMenuItem.title = "状态：\(msg)"
                        }
                    }
                }
            }

            var ok = false
            do {
                try task.run()
                task.waitUntilExit()
                ok = (task.terminationStatus == 0)
            } catch {
                ok = false
            }
            pipe.fileHandleForReading.readabilityHandler = nil

            DispatchQueue.main.async {
                let msg = ok
                    ? (lastLine.isEmpty ? "\(label)完成" : lastLine)
                    : "\(label)失败，请查看日志"
                self?.endBusy(success: ok, message: msg)
                completion(ok, msg)
            }
        }
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
        // 生成报告：会先补齐未分析会话，再聚类 + LLM 润色，耗时较长，带进度反馈
        runOtusTask(label: "生成报告中", arguments: ["export"]) { _, _ in }
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
        // 补齐分析：只分析不入报告，同样可能耗时，带进度反馈
        runOtusTask(label: "补齐分析中", arguments: ["analyze"]) { _, _ in }
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

    // 独立复盘模型配置
    var customReportCheck: NSButton!
    var reportUrlLabel: NSTextField!
    var reportUrlField: NSTextField!
    var reportKeyLabel: NSTextField!
    var reportKeyField: NSSecureTextField!

    var statusLabel: NSTextField!

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 410),
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

        var y: CGFloat = 360
        let labelWidth: CGFloat = 108
        let fieldWidth: CGFloat = 330
        let fieldX: CGFloat = 140

        // 1. 预设提供商下拉选择
        contentView.addSubview(createLabel("服务提供商", y: y, width: labelWidth))

        providerPopUp = NSPopUpButton(frame: NSRect(x: fieldX, y: y - 4, width: fieldWidth, height: 26))
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

        // 2. 主 API Base URL
        y -= 40
        contentView.addSubview(createLabel("API 接口地址", y: y, width: labelWidth))
        urlField = NSTextField(frame: NSRect(x: fieldX, y: y, width: fieldWidth, height: 24))
        contentView.addSubview(urlField)

        // 3. 主 API Key
        y -= 38
        contentView.addSubview(createLabel("API 密钥 (Key)", y: y, width: labelWidth))
        keyField = NSSecureTextField(frame: NSRect(x: fieldX, y: y, width: fieldWidth, height: 24))
        contentView.addSubview(keyField)

        // 4. 会话分析模型 + ⓘ 纯悬停信息图标 (无冒号、不可点击)
        y -= 38
        contentView.addSubview(createLabel("会话分析模型", y: y, width: labelWidth))
        let aTip = "【白天高频微会话分析】\n每当切屏或累积活动时自动在后台静默触发，负责切分会话并提取项目和标签。\n建议优先考虑响应速度与调用成本，选用轻量快速模型。"
        let aInfoIcon = createInfoIcon(x: labelWidth + 13, y: y + 4, tip: aTip)
        contentView.addSubview(aInfoIcon)

        analysisField = NSTextField(frame: NSRect(x: fieldX, y: y, width: fieldWidth, height: 24))
        analysisField.placeholderString = "请填写微会话分析模型名称"
        analysisField.toolTip = aTip
        contentView.addSubview(analysisField)

        // 5. 深度复盘模型 + ⓘ 纯悬停信息图标 (无冒号、不可点击)
        y -= 38
        contentView.addSubview(createLabel("深度复盘模型", y: y, width: labelWidth))
        let rTip = "【晚间全天深度复盘】\n每天仅生成日终报告时触发一次，负责结合全天上下文梳理技术决策与攻坚历程。\n建议优先考虑上下文长度与逻辑分析质量，选用综合推理能力强的模型。"
        let rInfoIcon = createInfoIcon(x: labelWidth + 13, y: y + 4, tip: rTip)
        contentView.addSubview(rInfoIcon)

        reportField = NSTextField(frame: NSRect(x: fieldX, y: y, width: fieldWidth, height: 24))
        reportField.placeholderString = "请填写深度复盘模型名称"
        reportField.toolTip = rTip
        contentView.addSubview(reportField)

        // 6. 独立复盘模型配置勾选框
        y -= 32
        customReportCheck = NSButton(checkboxWithTitle: "深度复盘使用独立平台接口与密钥", target: self, action: #selector(toggleCustomReport))
        customReportCheck.frame = NSRect(x: fieldX, y: y, width: fieldWidth, height: 20)
        customReportCheck.font = NSFont.systemFont(ofSize: 11.5)
        contentView.addSubview(customReportCheck)

        // 7. 独立复盘接口字段 (受勾选框控制启用/置灰，无冒号)
        y -= 34
        reportUrlLabel = createLabel("复盘 API 接口", y: y, width: labelWidth)
        contentView.addSubview(reportUrlLabel)
        reportUrlField = NSTextField(frame: NSRect(x: fieldX, y: y, width: fieldWidth, height: 24))
        contentView.addSubview(reportUrlField)

        y -= 36
        reportKeyLabel = createLabel("复盘 API 密钥", y: y, width: labelWidth)
        contentView.addSubview(reportKeyLabel)
        reportKeyField = NSSecureTextField(frame: NSRect(x: fieldX, y: y, width: fieldWidth, height: 24))
        contentView.addSubview(reportKeyField)

        // 8. Status Label (连接测试状态反馈)
        y -= 30
        statusLabel = NSTextField(frame: NSRect(x: fieldX, y: y, width: fieldWidth, height: 18))
        statusLabel.isBezeled = false
        statusLabel.isEditable = false
        statusLabel.drawsBackground = false
        statusLabel.font = NSFont.systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        contentView.addSubview(statusLabel)

        // 9. 按钮区域
        y -= 38
        let testBtn = NSButton(frame: NSRect(x: fieldX, y: y, width: 95, height: 28))
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

        let saveBtn = NSButton(frame: NSRect(x: 375, y: y, width: 95, height: 28))
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

    private func createInfoIcon(x: CGFloat, y: CGFloat, tip: String) -> NSImageView {
        let iv = NSImageView(frame: NSRect(x: x, y: y, width: 14, height: 14))
        let conf = NSImage.SymbolConfiguration(pointSize: 11, weight: .regular)
        iv.image = NSImage(systemSymbolName: "info.circle", accessibilityDescription: "说明")?.withSymbolConfiguration(conf)
        iv.contentTintColor = .secondaryLabelColor
        iv.toolTip = tip
        return iv
    }

    @objc private func toggleCustomReport() {
        let isCustom = customReportCheck.state == .on
        reportUrlField.isEnabled = isCustom
        reportKeyField.isEnabled = isCustom
        reportUrlLabel.textColor = isCustom ? .labelColor : .tertiaryLabelColor
        reportKeyLabel.textColor = isCustom ? .labelColor : .tertiaryLabelColor
        if !isCustom {
            reportUrlField.placeholderString = "默认共用上方主 API 接口地址"
            reportKeyField.placeholderString = "默认共用上方主 API 密钥"
        } else {
            reportUrlField.placeholderString = "例如：https://api.openai.com/v1"
            reportKeyField.placeholderString = "sk-..."
        }
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
        var rUrl = ""
        var rKey = ""

        if let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let u = json["llmApiBase"] as? String { url = u }
            if let k = json["llmApiKey"] as? String { key = k }
            if let a = json["analysisModel"] as? String { analysis = a }
            if let r = json["reportModel"] as? String { report = r }
            if let ru = json["reportApiBase"] as? String { rUrl = ru }
            if let rk = json["reportApiKey"] as? String { rKey = rk }
        }

        urlField.stringValue = url
        keyField.stringValue = key
        analysisField.stringValue = analysis
        reportField.stringValue = report

        if !rUrl.isEmpty {
            reportUrlField.stringValue = rUrl
            reportKeyField.stringValue = rKey
            customReportCheck.state = .on
        } else {
            reportUrlField.stringValue = ""
            reportKeyField.stringValue = ""
            customReportCheck.state = .off
        }
        toggleCustomReport()

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
        statusLabel.stringValue = "正在测试主接口连接..."
        statusLabel.textColor = .secondaryLabelColor

        let urlStr = urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let keyStr = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let url = URL(string: "\(urlStr)/models") else {
            statusLabel.stringValue = "✕ 主 API 地址无效"
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
                    self.statusLabel.stringValue = "✕ 主接口失败: \(error.localizedDescription)"
                    self.statusLabel.textColor = .systemRed
                    return
                }
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                    self.statusLabel.stringValue = "✕ 主接口异常 (HTTP \(code))"
                    self.statusLabel.textColor = .systemRed
                    return
                }

                if self.customReportCheck.state == .on {
                    let rUrlStr = self.reportUrlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                    let rKeyStr = self.reportKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !rUrlStr.isEmpty, let rUrl = URL(string: "\(rUrlStr)/models") {
                        self.statusLabel.stringValue = "主接口成功，正在测试独立复盘接口..."
                        var rReq = URLRequest(url: rUrl)
                        rReq.httpMethod = "GET"
                        rReq.timeoutInterval = 4.0
                        if !rKeyStr.isEmpty {
                            rReq.setValue("Bearer \(rKeyStr)", forHTTPHeaderField: "Authorization")
                        }
                        URLSession.shared.dataTask(with: rReq) { _, rResp, rErr in
                            DispatchQueue.main.async {
                                if let rErr = rErr {
                                    self.statusLabel.stringValue = "✓ 主接口成功，但独立复盘接口连接失败: \(rErr.localizedDescription)"
                                    self.statusLabel.textColor = .systemOrange
                                } else if let rHttp = rResp as? HTTPURLResponse, (200...299).contains(rHttp.statusCode) {
                                    self.statusLabel.stringValue = "✓ 两个接口均连接成功 (HTTP 200)"
                                    self.statusLabel.textColor = .systemGreen
                                } else {
                                    let rCode = (rResp as? HTTPURLResponse)?.statusCode ?? 0
                                    self.statusLabel.stringValue = "✓ 主接口成功，复盘接口异常 (HTTP \(rCode))"
                                    self.statusLabel.textColor = .systemOrange
                                }
                            }
                        }.resume()
                        return
                    }
                }

                self.statusLabel.stringValue = "✓ 连接成功 (HTTP \(http.statusCode))"
                self.statusLabel.textColor = .systemGreen
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

        if customReportCheck.state == .on {
            let rUrl = reportUrlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let rKey = reportKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !rUrl.isEmpty {
                dict["reportApiBase"] = rUrl
            } else {
                dict.removeValue(forKey: "reportApiBase")
            }
            if !rKey.isEmpty {
                dict["reportApiKey"] = rKey
            } else {
                dict.removeValue(forKey: "reportApiKey")
            }
        } else {
            dict.removeValue(forKey: "reportApiBase")
            dict.removeValue(forKey: "reportApiKey")
        }

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
