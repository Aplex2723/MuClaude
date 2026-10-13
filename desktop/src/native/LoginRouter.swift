import AppKit
import Darwin

private func report(_ status: String, _ message: String? = nil) {
    var event = ["status": status]
    if let message { event["message"] = message }
    if let json = try? JSONSerialization.data(withJSONObject: event) {
        let data = json + Data([10])
        data.withUnsafeBytes { _ = Darwin.write(STDOUT_FILENO, $0.baseAddress, data.count) }
    }
}

final class LoginRouter: NSObject, NSApplicationDelegate {
    let target: RouteTarget
    let recoveryFile: URL
    var pid: pid_t?
    var previousApp: URL?
    var timer: Timer?
    var signals = [DispatchSourceSignal]()
    var arming = false
    var finishing = false
    var requestedFinish: (String, String?)?
    let sampleURL = URL(string: "claude://login/google-auth")!

    init(target: RouteTarget, configURL: URL) {
        self.target = target
        self.recoveryFile = configURL.deletingLastPathComponent().appendingPathComponent("google-handler-recovery.json")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { self.finish("cancelled") }
            source.resume(); signals.append(source)
        }
        signal(SIGPIPE, SIG_IGN)
        let ownID = Bundle.main.bundleIdentifier
        if NSWorkspace.shared.runningApplications.contains(where: { $0.processIdentifier != getpid() && $0.bundleIdentifier == ownID }) {
            report("error", "Another Google sign-in router is already active. Finish or cancel it first."); exit(1)
        }
        let deadline = Date().addingTimeInterval(10)
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
            let candidates = NSWorkspace.shared.runningApplications.filter { matchesProcess($0.processIdentifier, target: self.target) }
            if candidates.count == 1 {
                self.pid = candidates[0].processIdentifier
                self.timer?.invalidate(); self.arm()
            } else if candidates.count > 1 || Date() >= deadline {
                self.timer?.invalidate()
                self.finish("error", "Open the selected Claude instance, then try Google sign-in again.")
            }
        }
    }

    func arm() {
        guard target.expiresAt > Date().timeIntervalSince1970 * 1000 else { finish("expired"); return }
        previousApp = NSWorkspace.shared.urlForApplication(toOpen: sampleURL)
        if previousApp.flatMap({ Bundle(url: $0)?.bundleIdentifier }) == Bundle.main.bundleIdentifier {
            if let data = try? Data(contentsOf: recoveryFile),
               let record = try? JSONSerialization.jsonObject(with: data) as? [String: String], let path = record["previousApp"] {
                previousApp = URL(fileURLWithPath: path)
            } else { previousApp = URL(fileURLWithPath: target.claudeApp) }
        }
        previousApp = previousApp ?? URL(fileURLWithPath: target.claudeApp)
        guard let previousApp, Bundle(url: previousApp)?.bundleIdentifier != Bundle.main.bundleIdentifier else {
            finish("error", "Could not identify the previous Claude link handler."); return
        }
        do {
            let record = try JSONSerialization.data(withJSONObject: ["previousApp": previousApp.path])
            try record.write(to: recoveryFile, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: recoveryFile.path)
        } catch { finish("error", "Could not save the previous Claude link handler."); return }
        arming = true
        // Changes only claude://, for this one sign-in. HTTPS/default browser stays as configured.
        // https://developer.apple.com/documentation/appkit/nsworkspace/setdefaultapplication(at:toopenurlswithscheme:completion:)
        NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpenURLsWithScheme: "claude") { error in
            DispatchQueue.main.async {
                self.arming = false
                if let requested = self.requestedFinish { self.finish(requested.0, requested.1); return }
                if error != nil { self.finish("error", "macOS could not enable Google sign-in routing."); return }
                report("ready")
                self.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                    if Date().timeIntervalSince1970 * 1000 >= self.target.expiresAt { self.finish("expired") }
                    else if let pid = self.pid, !matchesProcess(pid, target: self.target) {
                        self.finish("error", "The selected Claude instance is no longer running.")
                    }
                }
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "claude" {
            if url.host == "login" && url.path == "/google-auth" {
                guard !finishing else { continue }
                guard let pid else { finish("error", "The selected Claude instance is no longer running."); return }
                do {
                    try forwardGoogleCallback(url.absoluteString, to: pid, target: target)
                    finish("forwarded")
                } catch { finish("error", "Could not deliver the Google response to the selected Claude instance. Please retry sign-in.") }
                return
            }
            // Unrelated Claude links keep going to the previous application.
            if let previousApp {
                NSWorkspace.shared.open([url], withApplicationAt: previousApp, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
            }
        }
    }

    func finish(_ status: String, _ message: String? = nil) {
        if arming { requestedFinish = (status, message); return }
        guard !finishing else { return }
        finishing = true; timer?.invalidate()
        let current = NSWorkspace.shared.urlForApplication(toOpen: sampleURL)
        let ours = current.flatMap { Bundle(url: $0)?.bundleIdentifier } == Bundle.main.bundleIdentifier
        if ours && previousApp == nil {
            if let data = try? Data(contentsOf: recoveryFile),
               let record = try? JSONSerialization.jsonObject(with: data) as? [String: String], let path = record["previousApp"] {
                previousApp = URL(fileURLWithPath: path)
            } else { previousApp = URL(fileURLWithPath: target.claudeApp) }
        }
        let done: (Error?) -> Void = { error in
            if error != nil { report("error", "Could not restore Claude as the link handler. Set Claude as the claude:// handler and retry."); exit(1) }
            try? FileManager.default.removeItem(at: self.recoveryFile)
            report(status, message); exit(status == "error" ? 1 : 0)
        }
        if ours, let previousApp {
            NSWorkspace.shared.setDefaultApplication(at: previousApp, toOpenURLsWithScheme: "claude", completion: done)
        } else { done(nil) } // never overwrite another app's later handler choice
    }
}

@main struct Main {
    static func main() {
        guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--route",
              let data = try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])),
              let target = try? JSONDecoder().decode(RouteTarget.self, from: data),
              target.profileDir.hasPrefix("/"), target.claudeApp.hasPrefix("/"),
              target.expiresAt.isFinite, target.expiresAt > Date().timeIntervalSince1970 * 1000 else {
            report("error", "Invalid or expired Google sign-in session."); exit(1)
        }
        let app = NSApplication.shared
        let delegate = LoginRouter(target: target, configURL: URL(fileURLWithPath: CommandLine.arguments[2]))
        app.delegate = delegate; app.setActivationPolicy(.prohibited); app.run()
    }
}
