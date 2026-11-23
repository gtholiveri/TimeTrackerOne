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
// The test, when an automation runs: does the watcher report this switch? It
// reads the current app every ~2 s and hands its lines over straight away
// while the phone is unlocked, which it is when an app opens. So a live
// watcher is heard within a few seconds of any switch. The app waits up to
// 8 s for that. If nothing came, and nothing came in the 30 s before the
// switch either (so a switch back to the very same app, which the watcher
// doesn't report, can't fool it), the watcher is dead and the automation
// starts a new one. A close and the next open arrive together; one "yes" per
// 2 minutes covers both. A watcher that reached the end of its loop counts as
// dead straight away. (The first version only compared with the previous
// switch, so a watcher that died needed two switches, about 7-9 minutes of
// use, before anything restarted it.)
//
// Never while locked. Locking fires the "closed" automation, and a watcher
// keeps its lines to itself while the phone is locked, so it would look dead.
// Starting TT Watch then fails anyway ("requires privacy permissions that
// cannot be granted while your device is locked", seen 2026-11-23 15:50).
// Data protection says the phone is locked about 10 s after the screen locks,
// so a close waits up to 15 s and answers false once it does. An open waits
// 8 s, and answers false if the phone is locked by then too.
//
// A false alarm would start a second watcher. The app keeps only the newest:
// Log TT Lines answers "stop" to any other run, and TT Watch stops on it.

import Foundation
import UIKit

enum TTWatchGuard {
    static let shortcutName = "TT Watch"
    static let cooldown: TimeInterval = 120
    /// How long to wait for the watcher to report this switch.
    static let reportWait: TimeInterval = 8
    /// A close may be the phone locking: long enough for data protection to say so (~10 s).
    static let closeWait: TimeInterval = 15
    /// Heard this recently before the switch: alive (covers same-app switches it doesn't report).
    static let recent: TimeInterval = 30

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
    static func needsStart(close: Bool = false) async -> Bool {
        let now = Date()
        markInUse(now)
        if await isLocked() { return false }
        if let h = lastHeard, !lastEnded, now.timeIntervalSince(h) < recent { return false }
        // Wait for the watcher to report this switch, or for the phone to turn out locked.
        let deadline = now.addingTimeInterval(close ? closeWait : reportWait)
        if !lastEnded && lastHeard != nil {
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if let h = lastHeard, h >= now.addingTimeInterval(-2) { return false }
                if lastEnded { break }
                if await isLocked() { return false }
            }
        } else if close {
            // Never heard, or it ended: still make sure this close isn't a lock.
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if await isLocked() { return false }
            }
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
