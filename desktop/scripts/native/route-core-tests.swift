import Foundation

@main struct RouteCoreTests {
    static func main() throws {
        let target = RouteTarget(profileDir: "/tmp/Claude-Personal Gabo", claudeApp: "/Applications/Claude.app", expiresAt: Date().timeIntervalSince1970 * 1000 + 60_000)
        let cases: [([String], Bool)] = [
            (["Claude", "--user-data-dir=/tmp/Claude-Personal Gabo"], true),
            (["Claude", "--user-data-dir", "/tmp/Claude-Personal Gabo"], true),
            (["Claude", "--user-data-dir=/tmp/Claude-Work"], false),
            (["Claude"], false),
            (["Claude", "--user-data-dir=/tmp/Claude-Personal Gabo-other"], false),
            (["Claude", "--user-data-dir=/tmp/Claude-Personal Gabo", "--user-data-dir=/tmp/Claude-Work"], false),
        ]
        for (argv, expected) in cases {
            precondition(matchesProfile(arguments: argv, target: target) == expected, "Wrong profile routing for \(argv)")
        }
        let callback = "claude://login/google-auth?code=test%2Bcode&hop_nonce=test-nonce&anon_id=test"
        precondition(isGoogleCallback(callback))
        for bad in ["https://login/google-auth?code=test", "claude://login/google-auth", "claude://login/google-auth?code=", "claude://claude.ai/new?code=test", "claude://login/google-auth?code=a&code=b", "claude://login/google-auth?code=test\n"] {
            precondition(!isGoogleCallback(bad), "Accepted malformed or unrelated callback")
        }
        do {
            try forwardGoogleCallback(callback, to: 0, target: target)
            preconditionFailure("A callback must never launch a new Claude or go to PID zero")
        } catch {}
        print("NATIVE ROUTE CORE OK: exact profile matching, callback validation and stale-PID refusal")
    }
}
