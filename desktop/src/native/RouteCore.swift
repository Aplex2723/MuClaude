import AppKit
import Darwin

struct RouteTarget: Codable {
    let profileDir: String
    let claudeApp: String
    let expiresAt: Double
}

enum RoutingError: Error { case invalidCallback, unavailableProcess, invalidArguments }

func normalizedPath(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

func matchesProfile(arguments: [String], target: RouteTarget) -> Bool {
    var profiles = [String]()
    for (index, arg) in arguments.enumerated() {
        if arg.hasPrefix("--user-data-dir=") { profiles.append(String(arg.dropFirst(16))) }
        else if arg == "--user-data-dir", index + 1 < arguments.count { profiles.append(arguments[index + 1]) }
    }
    return profiles.count == 1 && profiles[0].hasPrefix("/") && normalizedPath(profiles[0]) == normalizedPath(target.profileDir)
}

func isGoogleCallback(_ value: String) -> Bool {
    guard value.utf8.count <= 16_384, !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let url = URLComponents(string: value), url.scheme == "claude", url.host == "login", url.path == "/google-auth",
          url.user == nil, url.password == nil, url.port == nil, url.fragment == nil else { return false }
    let codes = (url.queryItems ?? []).filter { $0.name == "code" }
    return codes.count == 1 && !(codes[0].value ?? "").isEmpty
}

// Read argv as separate strings. Parsing `ps` text loses boundaries for profile
// paths with spaces; KERN_PROCARGS2 provides argc followed by NUL-separated argv.
func processArguments(_ pid: pid_t) throws -> [String] {
    guard pid > 0 else { throw RoutingError.unavailableProcess }
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4, size <= 4 * 1024 * 1024 else { throw RoutingError.unavailableProcess }
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { throw RoutingError.unavailableProcess }
    let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard argc > 0, argc < 4096 else { throw RoutingError.invalidArguments }
    var index = 4
    while index < size && bytes[index] != 0 { index += 1 } // executable path
    while index < size && bytes[index] == 0 { index += 1 } // padding
    var args = [String]()
    for _ in 0..<argc {
        let start = index
        while index < size && bytes[index] != 0 { index += 1 }
        guard index < size, let arg = String(bytes: bytes[start..<index], encoding: .utf8) else { throw RoutingError.invalidArguments }
        args.append(arg); index += 1
    }
    return args
}

func matchesProcess(_ pid: pid_t, target: RouteTarget) -> Bool {
    guard pid > 0, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
          let executable = app.executableURL,
          let expected = Bundle(url: URL(fileURLWithPath: target.claudeApp))?.executableURL,
          normalizedPath(executable.path) == normalizedPath(expected.path),
          let argv = try? processArguments(pid) else { return false }
    return matchesProfile(arguments: argv, target: target)
}

func forwardGoogleCallback(_ value: String, to pid: pid_t, target: RouteTarget) throws {
    guard isGoogleCallback(value) else { throw RoutingError.invalidCallback }
    guard target.expiresAt > Date().timeIntervalSince1970 * 1000, matchesProcess(pid, target: target) else { throw RoutingError.unavailableProcess }
    // Target the running PID, never the shared Claude bundle id. Preserve the
    // original URL, including hop_nonce; Claude performs its own nonce check.
    // https://developer.apple.com/documentation/foundation/nsappleeventdescriptor/init(processidentifier:)
    let event = NSAppleEventDescriptor(eventClass: 0x4755524c, eventID: 0x4755524c,
        targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid), returnID: -1, transactionID: 0)
    event.setParam(NSAppleEventDescriptor(string: value), forKeyword: 0x2d2d2d2d)
    _ = try event.sendEvent(options: .noReply, timeout: 5)
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
}
