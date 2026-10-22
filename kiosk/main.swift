// AI Panel Kiosk — a borderless WebKit window that shows the panel full screen on a chosen display.
//
//   ai-panel-kiosk [--config kiosk.conf] [--url http://127.0.0.1:7319/]
//
// kiosk.conf (shell style, optional):
//   SCREEN_NAME="M14"   display name from System Settings → Displays; without it, the first display
//                       wider than 2:1 is used. The main display is never used.
//   PANEL_LANG="pl"     forces the interface language (default: system language)
//
// The window follows the display: it appears when the display is connected and goes away when it is
// unplugged. It covers the whole display, including the menu bar area, and stays above other windows
// on that display only.
import AppKit
import WebKit

struct Config {
    var screenName = ""
    var lang = ""
    var url = "http://127.0.0.1:7319/"

    static func load(_ args: [String]) -> Config {
        var c = Config()
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--config" where i + 1 < args.count:
                c.read(file: args[i + 1]); i += 1
            case "--url" where i + 1 < args.count:
                c.url = args[i + 1]; i += 1
            default: break
            }
            i += 1
        }
        return c
    }

    mutating func read(file: String) {
        guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, !parts[0].hasPrefix("#") else { continue }
            var value = parts[1]
            if let hash = value.range(of: " #") { value = String(value[..<hash.lowerBound]) }  // trailing comment
            value = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            switch parts[0] {
            case "SCREEN_NAME": screenName = value
            case "PANEL_LANG": lang = value
            default: break
            }
        }
    }

    var pageURL: URL {
        var u = URLComponents(string: url)!
        if !lang.isEmpty { u.queryItems = [URLQueryItem(name: "lang", value: lang)] }
        return u.url!
    }
}

final class Kiosk: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let config: Config
    var window: NSWindow?
    var webView: WKWebView?
    var retry: Timer?

    init(config: Config) { self.config = config }

    func applicationDidFinishLaunching(_ note: Notification) {
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        screensChanged()
    }

    /// The panel display, or nil. Never the main display (index 0), so the kiosk cannot take it over.
    func panelScreen() -> NSScreen? {
        let others = NSScreen.screens.dropFirst()
        if !config.screenName.isEmpty {
            return others.first { $0.localizedName == config.screenName }
        }
        return others.first { $0.frame.width / $0.frame.height > 2 }
    }

    @objc func screensChanged() {
        guard let screen = panelScreen() else {
            window?.orderOut(nil)  // display unplugged: hide instead of falling back to another screen
            return
        }
        let win = window ?? makeWindow()
        win.setFrame(screen.frame, display: true)
        win.orderFrontRegardless()
    }

    func makeWindow() -> NSWindow {
        let win = NSWindow(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
        // Above the menu bar of its own display; other displays are not affected.
        win.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        win.isReleasedWhenClosed = false
        win.backgroundColor = .black

        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()  // keeps localStorage (theme, expanded groups) between runs
        let web = WKWebView(frame: .zero, configuration: conf)
        web.navigationDelegate = self
        web.allowsMagnification = false
        web.setValue(false, forKey: "drawsBackground")
        win.contentView = web
        web.load(URLRequest(url: config.pageURL))

        window = win
        webView = web
        return win
    }

    // Stay on the panel: anything that is not the local server opens in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let host = action.request.url?.host
        if host == "127.0.0.1" || host == "localhost" {
            decisionHandler(.allow)
        } else {
            if let url = action.request.url, url.scheme == "https" { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    // The server may be restarting: try again shortly instead of showing an error page forever.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        scheduleReload()
    }

    func webView(_ webView: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        scheduleReload()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        scheduleReload()
    }

    func scheduleReload() {
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.webView?.load(URLRequest(url: self.config.pageURL))
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // no Dock icon, no menu bar of its own
let kiosk = Kiosk(config: Config.load(Array(CommandLine.arguments.dropFirst())))
app.delegate = kiosk
app.run()
