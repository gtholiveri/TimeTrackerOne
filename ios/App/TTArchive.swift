// A local copy of every line the app records, one file per day, for the data
// viewer. The upload queue (TTLog) empties as lines reach the relay; this
// doesn't, so the viewer works offline and shows exactly what the phone saw.
//
// Lines are filed by the date in their own ts (local time with an offset), so
// TT Watch's overnight lines, handed over at the morning unlock, land on the
// night they happened. Files older than `keepDays` are deleted.

import Foundation

enum TTArchive {
    static let keepDays = 180

    static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("tt-archive", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func dayKey(_ date: Date) -> String { dayFormat.string(from: date) }

    static func date(ofDay key: String) -> Date? { dayFormat.date(from: key) }

    /// The yyyy-MM-dd a line belongs to: the start of its ts, else today.
    static func day(of line: String) -> String {
        if let r = line.range(of: "|ts=") {
            let rest = line[r.upperBound...]
            if rest.count >= 10 {
                let key = String(rest.prefix(10))
                if dayFormat.date(from: key) != nil { return key }
            }
        }
        return dayKey(Date())
    }

    /// Appends lines to their days' files. Called from TTLog's actor, so writes don't interleave.
    static func append(_ lines: [String]) {
        var byDay: [String: [String]] = [:]
        for l in lines { byDay[day(of: l), default: []].append(l) }
        for (key, group) in byDay {
            let url = dir.appendingPathComponent("\(key).txt")
            let data = Data((group.joined(separator: "\n") + "\n").utf8)
            if let h = try? FileHandle(forWritingTo: url) {
                defer { try? h.close() }
                _ = try? h.seekToEnd()
                try? h.write(contentsOf: data)
            } else {
                try? data.write(to: url, options: [.completeFileProtectionUntilFirstUserAuthentication])
            }
        }
        pruneOccasionally()
    }

    /// The raw lines filed under a day, in file order.
    static func lines(day key: String) -> [String] {
        let url = dir.appendingPathComponent("\(key).txt")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    /// Days that have a file, newest first.
    static func days() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasSuffix(".txt") }.map { String($0.dropLast(4)) }.sorted(by: >)
    }

    /// Total size of the archive in bytes.
    static func size() -> Int {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.reduce(0) { sum, n in
            let a = try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(n).path)
            return sum + ((a?[.size] as? Int) ?? 0)
        }
    }

    private static func pruneOccasionally() {
        let defaults = UserDefaults.standard
        let last = defaults.object(forKey: "archivePruned") as? Date ?? .distantPast
        guard Date().timeIntervalSince(last) > 24 * 3600 else { return }
        defaults.set(Date(), forKey: "archivePruned")
        let cutoff = dayKey(Date().addingTimeInterval(-Double(keepDays) * 24 * 3600))
        for key in days() where key < cutoff {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(key).txt"))
        }
    }
}
