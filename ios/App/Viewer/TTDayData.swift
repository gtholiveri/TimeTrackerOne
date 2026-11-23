// One day of phone lines for the viewer: the local archive merged with what
// the relay has (older days, and anything from before the archive existed).

import CoreLocation
import Foundation

struct PhoneLine: Identifiable, Hashable {
    let raw: String
    let fields: [String: String]
    let date: Date?
    var id: String { raw }

    var kind: String { fields["kind"] ?? "?" }
    subscript(_ key: String) -> String? { fields[key] }

    init?(_ raw: String) {
        guard raw.hasPrefix("tt|") else { return nil }
        var out: [String: String] = [:]
        var last: String?
        for part in raw.dropFirst(3).split(separator: "|", omittingEmptySubsequences: false) {
            if let eq = part.firstIndex(of: "="), part[part.startIndex..<eq].allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }) {
                let k = String(part[part.startIndex..<eq])
                out[k] = String(part[part.index(after: eq)...])
                last = k
            } else if let k = last {
                out[k, default: ""] += "|" + part  // a value that contained "|"
            }
        }
        self.raw = raw
        fields = out
        date = TTTime.parse(out["ts"])
    }

    /// Same event whatever the device name says (the relay renames "iPhone").
    var dedupeKey: String { "\(kind)|\(fields["ts"] ?? "")|\(fields["run"] ?? "")|\(fields["lat"] ?? "")|\(fields["cur"] ?? "")" }

    var coordinate: CLLocationCoordinate2D? {
        guard let lat = fields["lat"].flatMap(Double.init), let lon = fields["lon"].flatMap(Double.init) else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    /// One line of plain text for lists.
    var summary: String {
        switch kind {
        case "open": return "Opened \(fields["cur"].flatMap { $0.isEmpty ? nil : $0 } ?? fields["input"] ?? "?")"
        case "close": return "Closed, now in \(fields["cur"] ?? "?")"
        case "start": return "TT Watch started (run \(fields["run"] ?? "?"))"
        case "end": return "TT Watch ended (run \(fields["run"] ?? "?"))"
        case "change":
            return fields["locked"] == "Yes" ? "Locked" : "Unlocked: \(fields["cur"] ?? "?")"
        case "beat": return "TT Watch heartbeat\(fields["battery"].map { $0.isEmpty ? "" : ", battery \($0)%" } ?? "")"
        case "motion": return "\(fields["activity"]?.capitalized ?? "?") (\(fields["conf"] ?? "?") confidence)"
        case "visit":
            let a = TTTime.clock(TTTime.parse(fields["arrive"])), d = TTTime.clock(TTTime.parse(fields["depart"]))
            return "Visit \(a) to \(fields["depart"] == "-" ? "now" : d), ±\(fields["acc"] ?? "?") m"
        case "loc": return "GPS fix ±\(fields["acc"] ?? "?") m, \(fields["speed"] ?? "?") m/s"
        case "locpause": return "GPS track paused (still)"
        default: return kind
        }
    }
}

enum DaySource: String { case local = "phone", relay = "relay", both = "phone + relay" }

struct DayLines {
    let day: String
    let lines: [PhoneLine]
    let source: DaySource
    let relayError: String?

    func of(_ kinds: Set<String>) -> [PhoneLine] { lines.filter { kinds.contains($0.kind) } }

    static func dayBounds(_ day: String) -> (Date, Date) {
        let start = Calendar.current.startOfDay(for: TTArchive.date(ofDay: day) ?? Date())
        return (start, Calendar.current.date(byAdding: .day, value: 1, to: start)!)
    }

    /// Local lines for the day, merged with the relay's when it answers.
    static func load(_ day: String, kinds: [String] = [], useRelay: Bool = true) async -> DayLines {
        let (start, end) = dayBounds(day)
        var local = TTArchive.lines(day: day).compactMap(PhoneLine.init)
        if !kinds.isEmpty { local = local.filter { kinds.contains($0.kind) } }
        var merged: [String: PhoneLine] = [:]
        for l in local { merged[l.dedupeKey] = l }
        var source = DaySource.local
        var err: String?
        if useRelay {
            do {
                let remote = try await TTRelayClient.fromSettings().lines(from: start, to: end, kinds: kinds)
                for l in remote.compactMap(PhoneLine.init) where merged[l.dedupeKey] == nil { merged[l.dedupeKey] = l }
                source = local.isEmpty ? .relay : .both
            } catch {
                err = error.localizedDescription
            }
        }
        let sorted = merged.values.filter { l in
            guard let d = l.date else { return true }
            return d >= start && d < end
        }.sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }
        return DayLines(day: day, lines: sorted, source: source, relayError: err)
    }
}
