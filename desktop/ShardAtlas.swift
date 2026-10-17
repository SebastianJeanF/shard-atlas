import Cocoa
import WebKit
import UniformTypeIdentifiers
import Darwin

struct DesktopConfiguration {
    let database: URL
    let backups: URL
    let log: URL
    let requestedPort: Int?
    let pythonCandidates: [String]
    let isQA: Bool
    let backendVersion: String

    init(arguments: [String] = CommandLine.arguments,
         environment: [String: String] = ProcessInfo.processInfo.environment,
         homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
         metadata suppliedMetadata: [String: Any]? = nil) {
        let support = homeDirectory
            .appendingPathComponent("Library/Application Support/Shard Atlas", isDirectory: true)
        func argument(_ name: String) -> String? {
            guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }
        let metadataURL = Bundle.main.url(forResource: "desktop-config", withExtension: "json")
        let metadata = suppliedMetadata ?? metadataURL.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        backendVersion = metadata["backendVersion"] as? String ?? "2.4.4"
        let qaDatabase = argument("--qa-db") ?? metadata["qaDatabase"] as? String
        isQA = qaDatabase != nil
        if let qaDatabase {
            database = URL(fileURLWithPath: NSString(string: qaDatabase).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath()
            backups = database.deletingLastPathComponent().appendingPathComponent("\(database.deletingPathExtension().lastPathComponent)-backups", isDirectory: true)
            log = database.deletingLastPathComponent().appendingPathComponent("server-desktop.log")
        } else {
            database = support.appendingPathComponent("shards.sqlite3").resolvingSymlinksInPath()
            if let configured = argument("--backup-dir") ?? metadata["backupDirectory"] as? String,
               !configured.isEmpty {
                backups = URL(fileURLWithPath: NSString(string: configured).expandingTildeInPath, isDirectory: true)
                    .standardizedFileURL.resolvingSymlinksInPath()
            } else {
                backups = support.appendingPathComponent("backups", isDirectory: true)
            }
            log = support.appendingPathComponent("server-desktop.log")
        }
        requestedPort = argument("--qa-port").flatMap(Int.init)
        var paths = metadata["pythonCandidates"] as? [String] ?? []
        // Finder supplies a small PATH; include standard Python.org and Homebrew locations.
        paths += (environment["PATH"] ?? "").split(separator: ":", omittingEmptySubsequences: true)
            .map { URL(fileURLWithPath: String($0), isDirectory: true).appendingPathComponent("python3").path }
        paths += ["/Library/Frameworks/Python.framework/Versions/Current/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        var seen = Set<String>()
        pythonCandidates = paths.filter { seen.insert($0).inserted }
    }
}

enum BackendError: LocalizedError {
    case unavailable(String)
    var errorDescription: String? {
        switch self { case .unavailable(let message): return message }
    }
}

final class LocalBackend {
    let configuration: DesktopConfiguration
    private let lock = NSLock()
    private var process: Process?
    private var stopping = false

    init(configuration: DesktopConfiguration) { self.configuration = configuration }

    func stop() {
        lock.lock()
        stopping = true
        let child = process
        process = nil
        lock.unlock()
        if let child, child.isRunning { child.terminate() }
    }

    private var stopped: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopping
    }

    private func health(_ port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return false }
        let semaphore = DispatchSemaphore(value: 0)
        var valid = false
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 0.35)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let reportedPath = payload["dbPath"] as? String else { return }
            let reportedDatabase = URL(fileURLWithPath: reportedPath).standardizedFileURL.resolvingSymlinksInPath()
            let expectedDatabase = self.configuration.database.standardizedFileURL.resolvingSymlinksInPath()
            valid = payload["app"] as? String == "shard-atlas"
                && payload["schemaVersion"] as? Int == 1
                && payload["backendVersion"] as? String == self.configuration.backendVersion
                && reportedDatabase.path == expectedDatabase.path
        }
        task.resume()
        if semaphore.wait(timeout: .now() + 0.5) == .timedOut { task.cancel(); return false }
        return valid
    }

    private func portAvailable(_ port: Int) -> Bool {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(port).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        return withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }

    private func python() throws -> URL {
        for candidate in configuration.pythonCandidates where FileManager.default.isExecutableFile(atPath: candidate) {
            if stopped { throw BackendError.unavailable("Startup was cancelled.") }
            let probe = Process()
            probe.executableURL = URL(fileURLWithPath: candidate)
            probe.arguments = ["-c", "import sys, sqlite3; sys.exit(0 if sys.version_info >= (3,10) else 1)"]
            probe.standardOutput = FileHandle.nullDevice
            probe.standardError = FileHandle.nullDevice
            do {
                try probe.run()
                probe.waitUntilExit()
                if probe.terminationStatus == 0 { return URL(fileURLWithPath: candidate) }
            } catch { continue }
        }
        throw BackendError.unavailable("Shard Atlas needs Python 3.10 or newer on this Mac. Rebuild the app with desktop/build.py --python /path/to/python3 after installing Python.")
    }

    func start() throws -> URL {
        let ports: [Int]
        if let requested = configuration.requestedPort {
            guard (1024...65535).contains(requested) else { throw BackendError.unavailable("The test port must be between 1024 and 65535.") }
            ports = [requested]
        } else { ports = Array(48731...48760) }
        for port in ports {
            if stopped { throw BackendError.unavailable("Startup was cancelled.") }
            if health(port) { return URL(string: "http://127.0.0.1:\(port)")! }
        }
        guard let runtime = Bundle.main.resourceURL?.appendingPathComponent("runtime", isDirectory: true),
              FileManager.default.fileExists(atPath: runtime.appendingPathComponent("server.py").path) else {
            throw BackendError.unavailable("The bundled Shard Atlas files are missing. Rebuild the app with desktop/build.py.")
        }
        let executable = try python()
        let files = FileManager.default
        try files.createDirectory(at: configuration.database.deletingLastPathComponent(), withIntermediateDirectories: true)
        try files.createDirectory(at: configuration.log.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !files.fileExists(atPath: configuration.log.path) { files.createFile(atPath: configuration.log.path, contents: nil) }
        guard let logHandle = try? FileHandle(forWritingTo: configuration.log) else {
            throw BackendError.unavailable("Shard Atlas could not open its log at \(configuration.log.path).")
        }
        try logHandle.seekToEnd()
        defer { try? logHandle.close() }
        for port in ports where portAvailable(port) {
            if stopped { throw BackendError.unavailable("Startup was cancelled.") }
            let child = Process()
            child.executableURL = executable
            child.arguments = [runtime.appendingPathComponent("server.py").path, "--db", configuration.database.path,
                               "--backup-dir", configuration.backups.path, "--port", String(port)]
            child.currentDirectoryURL = runtime
            var environment = ProcessInfo.processInfo.environment
            environment["PYTHONUNBUFFERED"] = "1"
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            child.environment = environment
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = logHandle
            child.standardError = logHandle
            lock.lock()
            if stopping { lock.unlock(); throw BackendError.unavailable("Startup was cancelled.") }
            do { try child.run(); process = child; lock.unlock() }
            catch { lock.unlock(); throw error }
            for _ in 0..<60 {
                if stopped { if child.isRunning { child.terminate() }; throw BackendError.unavailable("Startup was cancelled.") }
                if health(port) { return URL(string: "http://127.0.0.1:\(port)")! }
                if !child.isRunning { break }
                Thread.sleep(forTimeInterval: 0.1)
            }
            if child.isRunning { child.terminate(); child.waitUntilExit() }
            lock.lock(); process = nil; lock.unlock()
        }
        throw BackendError.unavailable("Shard Atlas could not start its local storage service. Open the log for details, then retry.")
    }
}

final class DesktopDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private let configuration = DesktopConfiguration()
    private var backend: LocalBackend?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var baseURL: URL?
    private var loaded = false
    private var quitting = false
    private var checkingQuit = false
    private var starting = false
    private var downloads: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createWindow()
        createMenus()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startBackend()
    }

    private func createWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 930),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = configuration.isQA ? "Shard Atlas QA" : "Shard Atlas"
        window.minSize = NSSize(width: 850, height: 620)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        let frameName = configuration.isQA ? "ShardAtlasTestWindow" : "ShardAtlasMainWindow"
        window.setFrameAutosaveName(frameName)
        window.setFrameUsingName(frameName)
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = .default()
        settings.preferences.javaScriptCanOpenWindowsAutomatically = false
        settings.userContentController.add(self, name: "nativeClipboard")
        settings.userContentController.addUserScript(WKUserScript(source: "window.isShardAtlasDesktop = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: settings)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window.contentView = webView
    }

    private func createMenus() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Shard Atlas")
        let about = NSMenuItem(title: "About Shard Atlas", action: #selector(showAbout), keyEquivalent: "")
        about.target = self; appMenu.addItem(about)
        appMenu.addItem(.separator())
        let settings = menuItem("Backup & Export…", command: "settings", key: ",")
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Shard Atlas", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Shard Atlas", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; main.addItem(appItem)
        let file = NSMenu(title: "File")
        file.addItem(menuItem("New Shard", command: "new", key: "n"))
        file.addItem(.separator())
        let close = NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        close.target = window; file.addItem(close)
        addMenu(file, to: main)
        let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
            if title == "Redo" { edit.addItem(.separator()) }
        }
        edit.addItem(.separator()); edit.addItem(menuItem("Find Shards", command: "search", key: "k"))
        addMenu(edit, to: main)
        let view = NSMenu(title: "View")
        for (title, command, key) in [("Library", "library", "1"), ("Topic Map", "atlas", "3"),
                                      ("C++ Releases", "timeline", "4")] {
            view.addItem(menuItem(title, command: command, key: key))
        }
        addMenu(view, to: main)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        addMenu(windowMenu, to: main); NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = main
    }

    private func addMenu(_ menu: NSMenu, to parent: NSMenu) {
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu; parent.addItem(item)
    }

    private func menuItem(_ title: String, command: String, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(runCommand(_:)), keyEquivalent: key)
        item.target = self; item.representedObject = command
        return item
    }

    @objc private func runCommand(_ sender: NSMenuItem) {
        guard loaded, !checkingQuit, window.attachedSheet == nil,
              let command = sender.representedObject as? String,
              ["new", "search", "library", "graph", "atlas", "timeline", "settings", "boards"].contains(command) else { return }
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript("window.shardAtlasDesktop?.command('\(command)')", completionHandler: nil)
    }

    @objc private func showAbout() {
        guard !checkingQuit, window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = "Shard Atlas"
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "2.1.3"
        alert.informativeText = "Connected technical knowledge.\nVersion \(version)\n\nYour shards, connections, and attachments are stored locally on this Mac."
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in self.finishSheet(alert.window) {} }
    }

    private func finishSheet(_ sheet: NSWindow, continuation: @escaping () -> Void) {
        sheet.orderOut(nil)
        DispatchQueue.main.async {
            continuation()
            DispatchQueue.main.async {
                guard !self.quitting, self.loaded, self.window.attachedSheet == nil,
                      self.window.contentView === self.webView else { return }
                self.window.makeKeyAndOrderFront(nil)
                self.window.makeFirstResponder(self.webView)
            }
        }
    }

    private func loadingView(message: String, retry: Bool = false) {
        let container = NSView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1440, height: 930))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(calibratedRed: 0.96, green: 0.955, blue: 0.938, alpha: 1).cgColor
        let title = NSTextField(labelWithString: retry ? "Shard Atlas could not open" : "Opening your atlas…")
        title.font = NSFont.systemFont(ofSize: 26, weight: .semibold)
        let detail = NSTextField(wrappingLabelWithString: message)
        detail.font = NSFont.systemFont(ofSize: 14)
        detail.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, detail])
        stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 18
        if retry {
            let buttons = NSStackView()
            buttons.spacing = 12
            let retryButton = NSButton(title: "Try Again", target: self, action: #selector(retryStartup))
            retryButton.bezelStyle = .rounded
            let logButton = NSButton(title: "Open Log", target: self, action: #selector(openLog))
            logButton.bezelStyle = .rounded
            buttons.addArrangedSubview(retryButton); buttons.addArrangedSubview(logButton)
            stack.addArrangedSubview(buttons)
        } else {
            let progress = NSProgressIndicator()
            progress.style = .spinning; progress.startAnimation(nil)
            stack.addArrangedSubview(progress)
        }
        container.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: container.centerXAnchor), stack.centerYAnchor.constraint(equalTo: container.centerYAnchor), stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560)])
        window.contentView = container
    }

    private func startBackend() {
        guard !starting else { return }
        starting = true; loaded = false
        loadingView(message: "Connecting to your knowledge on this Mac.")
        let service = LocalBackend(configuration: configuration)
        backend = service
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try service.start() }
            DispatchQueue.main.async {
                self.starting = false
                guard !self.quitting else { return }
                switch result {
                case .success(let url):
                    self.baseURL = url
                    self.window.contentView = self.webView
                    self.window.makeFirstResponder(self.webView)
                    self.webView.load(URLRequest(url: url))
                case .failure(let error):
                    service.stop()
                    self.loadingView(message: error.localizedDescription, retry: true)
                }
            }
        }
    }

    @objc private func retryStartup() { backend?.stop(); startBackend() }
    @objc private func openLog() {
        if FileManager.default.fileExists(atPath: configuration.log.path) { NSWorkspace.shared.open(configuration.log) }
        else { NSWorkspace.shared.open(configuration.log.deletingLastPathComponent()) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting || !loaded { quitting = true; return .terminateNow }
        if checkingQuit { return .terminateLater }
        if window.attachedSheet != nil { return .terminateCancel }
        checkingQuit = true
        if !downloads.isEmpty { keepOpenForExport(); return .terminateLater }
        webView.evaluateJavaScript("window.shardAtlasDesktop?.status()") { result, error in
            if self.window.attachedSheet != nil { self.finishQuit(false); return }
            if !self.downloads.isEmpty { self.keepOpenForExport(); return }
            guard error == nil, let status = result as? [String: Any],
                  let saving = status["saving"] as? Bool,
                  let dirty = status["dirty"] as? Bool else {
                let alert = NSAlert(); alert.messageText = "Check your changes before quitting"
                alert.informativeText = "Shard Atlas could not check the current form or save state. Keep it open to review your changes."
                alert.addButton(withTitle: "Keep Shard Atlas Open"); alert.addButton(withTitle: "Quit Anyway")
                alert.beginSheetModal(for: self.window) { response in
                    self.finishSheet(alert.window) { self.finishQuit(response == .alertSecondButtonReturn) }
                }
                return
            }
            if saving {
                let alert = NSAlert(); alert.messageText = "Your changes are being saved"
                alert.informativeText = "Please wait for the save to finish before quitting."
                alert.addButton(withTitle: "Keep Shard Atlas Open")
                alert.beginSheetModal(for: self.window) { _ in
                    self.finishSheet(alert.window) { self.finishQuit(false) }
                }
            } else if dirty {
                let alert = NSAlert(); alert.messageText = "Quit with unsaved changes?"
                alert.informativeText = status["draftSaved"] as? Bool == true
                    ? "The current form has unsaved changes. A recovery draft is available next time you open Shard Atlas."
                    : "The current form has unsaved changes. Keep editing to save them to your atlas."
                alert.addButton(withTitle: "Keep Editing"); alert.addButton(withTitle: "Quit Without Saving")
                alert.beginSheetModal(for: self.window) { response in
                    let discard = response == .alertSecondButtonReturn
                    self.finishSheet(alert.window) { self.finishQuit(discard) }
                }
            } else { self.finishQuit(true) }
        }
        return .terminateLater
    }

    private func finishQuit(_ allow: Bool) {
        checkingQuit = false
        quitting = allow
        NSApp.reply(toApplicationShouldTerminate: allow)
    }

    private func keepOpenForExport() {
        let alert = NSAlert(); alert.messageText = "Your export is being saved"
        alert.informativeText = "Please wait for the export to finish before quitting."
        alert.addButton(withTitle: "Keep Shard Atlas Open")
        alert.beginSheetModal(for: window) { _ in
            self.finishSheet(alert.window) { self.finishQuit(false) }
        }
    }

    func applicationWillTerminate(_ notification: Notification) { backend?.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return true
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url, let baseURL else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == baseURL.port && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if isLocal(url) {
            if navigationAction.shouldPerformDownload { decisionHandler(.download) }
            else if navigationAction.targetFrame == nil { webView.load(navigationAction.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
            return
        }
        if navigationAction.navigationType == .linkActivated, let url, ["http", "https"].contains(url.scheme ?? ""), url.user == nil, url.password == nil {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard isLocal(navigationResponse.response.url) else { decisionHandler(.cancel); return }
        let response = navigationResponse.response as? HTTPURLResponse
        let attachment = response?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailure(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailure(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        loadingView(message: "The app window stopped responding. Your saved knowledge is safe. Try opening it again.", retry: true)
    }
    private func navigationFailure(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled || (error as NSError).code == 102 { return }
        loaded = false; loadingView(message: error.localizedDescription, retry: true)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeClipboard", message.frameInfo.isMainFrame,
              isLocal(message.frameInfo.request.url),
              let payload = message.body as? [String: Any], payload.count == 1,
              let text = payload["text"] as? String, text.utf8.count <= 2_000_000 else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if isLocal(navigationAction.request.url) { webView.load(navigationAction.request) }
        else if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url,
                ["http", "https"].contains(url.scheme ?? ""), url.user == nil, url.password == nil {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard isLocal(frame.request.url) else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = "Shard Atlas"; alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in self.finishSheet(alert.window, continuation: completionHandler) }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard isLocal(frame.request.url) else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = "Shard Atlas"; alert.informativeText = message
        alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            self.finishSheet(alert.window) { completionHandler(response == .alertFirstButtonReturn) }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard isLocal(frame.request.url) else { completionHandler(nil); return }
        let alert = NSAlert(); alert.messageText = "Shard Atlas"; alert.informativeText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 350, height: 24)); input.stringValue = defaultText ?? ""
        alert.accessoryView = input; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            input.validateEditing()
            let text = response == .alertFirstButtonReturn ? input.stringValue : nil
            self.finishSheet(alert.window) { completionHandler(text) }
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard isLocal(frame.request.url) else { completionHandler(nil); return }
        webView.evaluateJavaScript("window.shardAtlasDesktop?.filePickerType?.()") { result, _ in
            guard !self.quitting else { completionHandler(nil); return }
            let panel = NSOpenPanel()
            panel.canChooseFiles = true; panel.canChooseDirectories = false
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            let images: [UTType] = [.png, .jpeg, .gif, .webP]
            switch result as? String {
            case "image": panel.title = "Attach an image"; panel.allowedContentTypes = images
            case "json": panel.title = "Import Shard Atlas JSON"; panel.allowedContentTypes = [.json]
            default: panel.title = "Choose a file"; panel.allowedContentTypes = [.json] + images
            }
            panel.beginSheetModal(for: self.window) { response in
                let urls = response == .OK ? panel.urls : nil
                self.finishSheet(panel) { completionHandler(urls) }
            }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard isLocal(response.url) else { completionHandler(nil); return }
        let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        let panel = NSSavePanel(); panel.title = "Export Shard Atlas"
        panel.nameFieldStringValue = name; panel.canCreateDirectories = true
        let suffix = URL(fileURLWithPath: name).pathExtension
        if suffix == "json" { panel.allowedContentTypes = [.json]; panel.allowsOtherFileTypes = false }
        else if suffix == "zip" { panel.allowedContentTypes = [.zip]; panel.allowsOtherFileTypes = false }
        panel.beginSheetModal(for: window) { response in
            let destination = response == .OK ? panel.url : nil
            self.finishSheet(panel) {
                guard let destination else { completionHandler(nil); return }
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("ShardAtlas-\(UUID().uuidString)-\(name)")
                self.downloads[ObjectIdentifier(download)] = (temporary, destination)
                completionHandler(temporary)
            }
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let record = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        do {
            if FileManager.default.fileExists(atPath: record.destination.path) {
                _ = try FileManager.default.replaceItemAt(record.destination, withItemAt: record.temporary)
            } else { try FileManager.default.moveItem(at: record.temporary, to: record.destination) }
        } catch { try? FileManager.default.removeItem(at: record.temporary); reportDownloadError(error) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let record = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: record.temporary) }
        if (error as NSError).code != NSURLErrorCancelled { reportDownloadError(error) }
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(isLocal(request.url) ? .allow : .cancel)
    }

    private func reportDownloadError(_ error: Error) {
        let alert = NSAlert(); alert.messageText = "The export could not be saved"
        alert.informativeText = error.localizedDescription; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in self.finishSheet(alert.window) {} }
    }
}

let application = NSApplication.shared
let delegate = DesktopDelegate()
application.delegate = delegate
application.run()
