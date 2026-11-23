// Reads from the relay for the data viewer, with the key the app already
// uploads with (the relay lets the ingest key read; it logs it as "phone").

import Foundation

struct TTRelayClient {
    let base: URL
    let key: String

    enum Failure: LocalizedError {
        case noRelay
        case http(Int, String)
        var errorDescription: String? {
            switch self {
            case .noRelay: return "No relay URL yet. TT Watch fills it in the first time it runs."
            case let .http(code, body): return "Relay answered HTTP \(code): \(body.prefix(200))"
            }
        }
    }

    /// From the ingest URL in settings: https://<relay>/tt/ingest?key=<key>.
    static func fromSettings() throws -> TTRelayClient {
        guard let parts = URLComponents(string: TTSettings.relayURL),
              let scheme = parts.scheme, let host = parts.host,
              let key = parts.queryItems?.first(where: { $0.name == "key" })?.value, !key.isEmpty
        else { throw Failure.noRelay }
        var root = URLComponents()
        root.scheme = scheme
        root.host = host
        root.port = parts.port
        guard let base = root.url else { throw Failure.noRelay }
        return TTRelayClient(base: base, key: key)
    }

    func data(_ path: String, _ query: [String: String] = [:]) async throws -> Data {
        var parts = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            // "+" in a time offset would read as a space.
            parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        var request = URLRequest(url: parts.url!, timeoutInterval: 30)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw Failure.http(code, String(decoding: data, as: UTF8.self))
        }
        return data
    }

    func decode<T: Decodable>(_ type: T.Type, _ path: String, _ query: [String: String] = [:]) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await data(path, query))
    }

    func json(_ path: String, _ query: [String: String] = [:]) async throws -> Any {
        try JSONSerialization.jsonObject(with: try await data(path, query))
    }

    /// Raw phone lines between two times, optionally only some kinds.
    func lines(from: Date, to: Date, kinds: [String] = []) async throws -> [String] {
        var q = ["source": "ios", "start": TTTime.iso(from), "end": TTTime.iso(to)]
        if !kinds.isEmpty { q["kinds"] = kinds.joined(separator: ",") }
        let text = String(decoding: try await data("tt/lines", q), as: UTF8.self)
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }
}

// MARK: - relay JSON

struct TTCoverage: Decodable {
    struct Day: Decodable, Identifiable {
        let day: String
        let ios: [String: Int]
        let ios_total: Int
        let safari: Int
        let devices: [String]
        let newest: String?
        var id: String { day }
    }
    struct Run: Decodable, Identifiable {
        let run: String
        let dev: String?
        let first: String
        let last: String
        let lines: Int
        let ended: Bool
        let hours: Double
        var id: String { run + first }
    }
    let tz: String
    let last_received: [String: String]
    let days: [Day]
    let watch_runs: [Run]
}

struct TTNamed: Decodable, Identifiable, Hashable {
    let name: String
    let seconds: Double
    var id: String { name }
}

struct TTSummary: Decodable {
    struct Day: Decodable, Identifiable {
        let day: String
        let attention_seconds: Double
        let first_active: String?
        let last_active: String?
        let by_rating: [String: Double]
        let by_top_category: [TTNamed]
        let by_category: [TTNamed]
        let by_device_kind: [String: Double]
        let device_seconds: [String: Double]
        let top_apps: [TTNamed]
        let top_domains: [TTNamed]
        let phone_unlocks: Int
        let longest_productive_streak_seconds: Double
        var id: String { day }
    }
    let days: [Day]
}

struct TTSegment: Decodable, Identifiable {
    let start: String
    let end: String
    let seconds: Double
    let device: String?
    let kind: String?
    let app: String?
    let title: String?
    let url: String?
    let domain: String?
    let category: String?
    let rating: String?
    let confidence: String?
    var id: String { start + (device ?? "") + (app ?? "") }
    var startDate: Date? { TTTime.parse(start) }
    var endDate: Date? { TTTime.parse(end) }
}

struct TTActivity: Decodable {
    let segments: [TTSegment]
}

// MARK: - times

enum TTTime {
    private static let lineFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSSXXX"
        return f
    }()
    private static let lineFormatNoMs: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ssXXX"
        return f
    }()
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso8601 = ISO8601DateFormatter()

    /// tt| line times ("2026-11-23 09:13:14.123-08:00") or ISO 8601.
    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty, s != "-" else { return nil }
        return lineFormat.date(from: s) ?? lineFormatNoMs.date(from: s) ?? isoFrac.date(from: s) ?? iso8601.date(from: s)
    }

    static func iso(_ d: Date) -> String { iso8601.string(from: d) }

    static func clock(_ d: Date?) -> String {
        guard let d else { return "?" }
        return d.formatted(date: .omitted, time: .shortened)
    }

    static func duration(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        return "\(m / 60)h \(String(format: "%02d", m % 60))m"
    }

    static func ago(_ d: Date?) -> String {
        guard let d else { return "never" }
        return d.formatted(.relative(presentation: .named))
    }
}
