import AppKit

final class Receiver: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        print("READY"); fflush(stdout)
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        try! urls[0].absoluteString.write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)
        application.terminate(nil)
    }
}

@main struct Fixture {
    static func main() {
        let app = NSApplication.shared
        let receiver = Receiver()
        app.delegate = receiver; app.setActivationPolicy(.prohibited); app.run()
    }
}
