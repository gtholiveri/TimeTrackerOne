// Keeps TT Watch running without you: the open/close automations ask the app
// whether the watcher is alive and start it themselves when it isn't.
//
// TT Watch adds a line whenever the lock state or the current app changes and
// hands it to the app (Log TT Lines) within a few seconds whenever the phone
// is unlocked. So a running watcher answers every app switch. Each switch also
// fires the automations, which call Log App Opened / Log App Closed; those
// return "TT Watch needs starting", and the automation's next step is
//     If <that> is true: Run Shortcut "TT Watch"
//
// The test, when an automation runs: was anything heard from the watcher
// since the previous switch? A close and the next open come within a second
// of each other, so of each pair only the one with a real gap to the previous
// switch decides. If nothing was heard, it waits 4 s (the watcher may be
// handing over its locked-time lines right now, at an unlock) and asks again.
// A watcher that reached the end of its loop counts as dead straight away.
// After asking for a start it says no for 2 minutes, so the new watcher has
// time to speak.
//
// A false alarm would start a second watcher. The app keeps only the newest:
// Log TT Lines answers "stop" to any other run, and TT Watch stops on it.

import Foundation

enum TTWatchGuard {
    static let shortcutName = "TT Watch"
    static let cooldown: TimeInterval = 120
    static let pairGap: TimeInterval = 10
    static let flushWait: UInt64 = 4_000_000_000

    private static let defaults = UserDefaults.standard
    private static let lock = NSLock()

    /// When the app last got a line from TT Watch.
    static var lastHeard: Date? { defaults.object(forKey: "watchLastHeard") as? Date }
    /// The run id of the watcher the app keeps (the newest that started).
    static var activeRun: String { defaults.string(forKey: "watchActiveRun") ?? "" }
    /// The run heard last, and whether its last line was its end.
    static var lastRun: String { defaults.string(forKey: "watchLastRun") ?? "" }
    static var lastEnded: Bool { defaults.bool(forKey: "watchLastEnded") }
    /// When an automation last ran (the phone was in use).
    static var lastInUse: Date? { defaults.object(forKey: "watchLastInUse") as? Date }
    /// When the app last told an automation to start TT Watch.
    static var lastStartAsked: Date? { defaults.object(forKey: "watchStartAsked") as? Date }
    /// How many times it has, for the app's screen.
    static var startsAsked: Int { defaults.integer(forKey: "watchStartsAsked") }
    /// How many times it told a watcher to stop (a newer one took over).
    static var stopsSent: Int { defaults.integer(forKey: "watchStopsSent") }

    /// For the app's screens: heard since the phone was last in use, and not ended.
    static var looksAlive: Bool {
        guard let heard = lastHeard, !lastEnded else { return false }
        if let used = lastInUse, used.timeIntervalSince(heard) > 30 { return false }
        return true
    }

    static var restartURL: URL {
        let name = shortcutName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "TT%20Watch"
        return URL(string: "shortcuts://run-shortcut?name=\(name)")!
    }

    // MARK: - Log TT Lines

    /// Lines handed over by Log TT Lines. Returns "stop" when they come from a
    /// watcher other than the newest one, else "ok".
    static func heard(_ lines: [String]) -> String {
        var run: String?
        var ended = false
        var started: String?
        for l in lines where l.contains("src=ios") {
            guard let kind = field("kind", in: l), ["start", "change", "beat", "end"].contains(kind) else { continue }
            if let r = field("run", in: l) { run = r }
            if kind == "start" { started = run }
            ended = kind == "end"
        }
        guard let run else { return "ok" }
        lock.lock()
        defer { lock.unlock() }
        if let started { defaults.set(started, forKey: "watchActiveRun") }
        let active = activeRun
        if active.isEmpty { defaults.set(run, forKey: "watchActiveRun") }
        if !active.isEmpty && run != active {
            // A newer watcher took over. This one's lines are still recorded.
            defaults.set(stopsSent + 1, forKey: "watchStopsSent")
            return "stop"
        }
        defaults.set(Date(), forKey: "watchLastHeard")
        defaults.set(run, forKey: "watchLastRun")
        defaults.set(ended, forKey: "watchLastEnded")
        return "ok"
    }

    // MARK: - Log App Opened / Closed

    /// Called by the open/close actions. True when the automation should run TT Watch.
    static func needsStart() async -> Bool {
        let now = Date()
        lock.lock()
        let prev = lastInUse
        defaults.set(now, forKey: "watchLastInUse")
        lock.unlock()

        if !lastEnded && lastHeard != nil {
            // The second of a close/open pair: the first one decides.
            guard let prev, now.timeIntervalSince(prev) >= pairGap else { return false }
            if heardSince(prev) { return false }
            try? await Task.sleep(nanoseconds: flushWait)
            if heardSince(prev) { return false }
        }
        return claimStart(now)
    }

    private static func heardSince(_ t: Date) -> Bool {
        guard let h = lastHeard else { return false }
        return h >= t.addingTimeInterval(-5)  // the watcher can beat the automation by a moment
    }

    /// One "yes" per cooldown, even when a close and an open ask at once.
    private static func claimStart(_ now: Date) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let asked = lastStartAsked, now.timeIntervalSince(asked) < cooldown { return false }
        defaults.set(now, forKey: "watchStartAsked")
        defaults.set(startsAsked + 1, forKey: "watchStartsAsked")
        return true
    }

    static func field(_ key: String, in line: String) -> String? {
        for part in line.split(separator: "|") where part.hasPrefix(key + "=") {
            return String(part.dropFirst(key.count + 1))
        }
        return nil
    }
}
