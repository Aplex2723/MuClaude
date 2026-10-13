import Foundation
import Darwin

@main struct Sender {
    static func main() throws {
        let target = RouteTarget(profileDir: CommandLine.arguments[2], claudeApp: CommandLine.arguments[3], expiresAt: Date().timeIntervalSince1970 * 1000 + 60_000)
        let input = FileHandle.standardInput.readDataToEndOfFile()
        do { try forwardGoogleCallback(String(decoding: input, as: UTF8.self), to: Int32(CommandLine.arguments[1])!, target: target) }
        catch { exit(1) }
        print("FORWARDED")
    }
}
