// Keeps TT Watch running without you: the open/close automations ask the app
// whether the watcher is alive and start it themselves when it isn't.
//
// The automation's steps: Get Current App -> Log App Opened / Log App Closed,
// which return "TT Watch needs starting" -> If <that> is true: Run Shortcut
// "TT Watch".
//
// How the app knows, at once and without waiting: TT Watch checks in with the
// app at least every ~12 s while the phone is unlocked (a ping, or its real
// lines), and keeps quiet only while locked (it can't hand anything over then;
// it hands it all over within one tick, ~2 s, of the unlock). So the app looks
// back at what it has heard:
//   - heard in the last 25 s: alive.
//   - a close, and nothing for 25 s: dead. An app was just in front, so the
//     phone was unlocked, and a live watcher would have checked in. Start it.
//   - an open, and nothing for 25 s: dead if it was already quiet at the
//     previous open/close too (the phone was in use, nothing came). If it was
//     alive then, the quiet stretch since is a lock, and its lines are a tick
//     away; a watcher that died during the lock is caught by the next close.
//   - a watcher that reached the end of its loop: dead.
// Data from 11-23 to 11-25 (3,245 lines): 6 silent deaths in 2.5 days, never
// an end line, and a close can't tell a lock from going Home by its app
// (same app in 68% of locks and 51% of Home closes).
//
// Locking fires the close automation, and starting TT Watch while locked fails
// ("requires privacy permissions that cannot be granted while your device is
// locked", 2026-11-23). Data protection only says "locked" ~10 s after the
// lock, too late for the close. So a close also reads SpringBoard's lock state
// (notify "com.apple.springboard.lockstate"), logged as lk= on every open and
// close line; the app trusts it once it has seen it read both 0 and 1. A dead
// watcher found at a lock may still get a start that fails with that banner;
// the next open starts it then.
//
// A TT Watch from before the pings (2026-11-26) gets the old rules: closes
// never start it, and an open waits up to 8 s for it to report the switch.
//
// A false alarm would start a second watcher. The app keeps only the newest:
// Log TT Lines answers "stop" to any other run, and TT Watch stops on it.

import Foundation
import notify
import UIKit

enum TTWatchGuard {
    static let shortcutName = "TT Watch"
    static let cooldown: TimeInterval = 120
    /// Old watchers (no pings): how long an open waits for one to report it,
    /// and how recently heard counts as alive.
    static let reportWait: TimeInterval = 8
    static let recent: TimeInterval = 150

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
        var pinged = false
        for l in lines where l.contains("src=ios") {
            guard let kind = field("kind", in: l), ["start", "change", "beat", "ping", "end"].contains(kind) else { continue }
            if let r = field("run", in: l) { run = r }
            if kind == "start" { started = run; pinged = false }
            if kind == "ping" { pinged = true }
            ended = kind == "end"
        }
        guard let run else { return "ok" }
        lock.lock()
        defer { lock.unlock() }
        if let started {
            defaults.set(started, forKey: "watchActiveRun")
            defaults.set(false, forKey: "watchActivePings")
        }
        let active = activeRun
        if active.isEmpty { defaults.set(run, forKey: "watchActiveRun") }
        if !active.isEmpty && run != active {
            // A newer watcher took over. This one's lines are still recorded.
            defaults.set(stopsSent + 1, forKey: "watchStopsSent")
            return "stop"
        }
        if pinged { defaults.set(true, forKey: "watchActivePings") }
        defaults.set(Date(), forKey: "watchLastHeard")
        defaults.set(run, forKey: "watchLastRun")
        defaults.set(ended, forKey: "watchLastEnded")
        return "ok"
    }

    // MARK: - Log App Opened / Closed

    /// Heard this recently: alive (TT Watch checks in every ~12 s while unlocked).
    static let fresh: TimeInterval = 25

    /// Whether the active run sends pings (the TT Watch from 2026-11-26 on).
    static var activePings: Bool { defaults.bool(forKey: "watchActivePings") }

    struct Decision {
        var start: Bool
        /// alive, dead, locked or old-watcher rules, for the open/close line (watch=).
        var why: String
        /// SpringBoard lock state at the event: 1 locked, 0 not, - unreadable.
        var lockState: String
        /// Data protection: 1 files readable (unlocked), 0 not.
        var protectedData: String
    }

    /// Called by the open/close actions. start is true when the automation should run TT Watch.
    static func decide(close: Bool) async -> Decision {
        let now = Date()
        let previousEvent = lastInUse
        markInUse(now)
        let lk = LockState.read()
        let pda = await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
        var d = Decision(start: false, why: "alive", lockState: lk.map(String.init) ?? "-", protectedData: pda ? "1" : "0")

        // Locked (or locking): can't be heard and can't be started.
        if !pda || (lk == 1 && LockState.trusted) { d.why = "locked"; return d }

        guard activePings || lastEnded || lastHeard == nil else {
            d.why = "old-watcher"
            d.start = close ? false : await legacyOpen(now)
            return d
        }
        if lastEnded || lastHeard == nil {
            d.why = "dead"
        } else if let h = lastHeard, now.timeIntervalSince(h) < fresh {
            return d
        } else if !close, let h = lastHeard, let p = previousEvent, h >= p.addingTimeInterval(-fresh) {
            // Alive at the previous open/close and quiet since: the phone was locked.
            d.why = "after-lock"
            return d
        } else {
            d.why = "dead"
        }
        d.start = claimStart(now)
        return d
    }

    /// The rules for a TT Watch that doesn't ping: wait up to 8 s for it to
    /// report this open, unless it was heard in the last 150 s.
    private static func legacyOpen(_ now: Date) async -> Bool {
        if let h = lastHeard, now.timeIntervalSince(h) < recent { return false }
        let deadline = now.addingTimeInterval(reportWait)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if let h = lastHeard, h >= now.addingTimeInterval(-2) { return false }
            if lastEnded { break }
            if await isLocked() { return false }
        }
        if await isLocked() { return false }
        return claimStart(now)
    }

    /// Data protection's view: locked once complete-protection files can't be read
    /// (about 10 s after the screen locks, with a passcode set).
    static func isLocked() async -> Bool {
        let available = await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
        if !available { return true }
        return FileManager.default.fileExists(atPath: ProtectedCanary.url.path) && !ProtectedCanary.readable()
    }

    /// Records this automation run (the phone is in use), for the app's screens.
    private static func markInUse(_ now: Date) {
        lock.withLock { defaults.set(now, forKey: "watchLastInUse") }
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

/// SpringBoard's lock state through notify(3): 1 locked, 0 unlocked, nil when
/// it can't be read. Not a public API, so the app only acts on it once it has
/// seen it read both 0 and 1 (it is logged on every open/close as lk=).
enum LockState {
    private static let defaults = UserDefaults.standard

    static func read() -> UInt64? {
        var token: Int32 = 0
        guard notify_register_check("com.apple.springboard.lockstate", &token) == 0 else { return nil }
        defer { notify_cancel(token) }
        var state: UInt64 = 0
        guard notify_get_state(token, &state) == 0 else { return nil }
        if state == 0 { defaults.set(true, forKey: "lockStateSeen0") }
        if state == 1 { defaults.set(true, forKey: "lockStateSeen1") }
        return state
    }

    static var trusted: Bool {
        defaults.bool(forKey: "lockStateSeen0") && defaults.bool(forKey: "lockStateSeen1")
    }
}
