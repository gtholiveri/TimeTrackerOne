// The phone-side log: every line the app records (app opens/closes passed in
// by Shortcuts, TT Watch's lines, location, motion) goes into one queue file
// in the app's container first, then up to the relay's /tt/ingest. A failed
// upload never surfaces: the lines stay queued and go with the next upload
// that works. The relay drops duplicates, so sending a line twice is harmless.
//
// The queue file uses .completeUntilFirstUserAuthentication protection, so it
// can be written while the phone is locked (after the first unlock since boot),
// unlike files in iCloud Drive > Shortcuts.

import Foundation

enum TTSettings {
    private static let defaults = UserDefaults.standard

    /// The relay ingest URL with its key, as TT Sync used it:
    /// https://<relay>/tt/ingest?key=<TT_INGEST_KEY>
    static var relayURL: String {
        get { defaults.string(forKey: "relayURL") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "relayURL") }
    }

    /// The device name the relay knows this phone by. Shortcuts' "Device Name"
    /// is the real one (UIDevice only says "iPhone"), so the shortcuts pass it in.
    static var deviceName: String {
        get { defaults.string(forKey: "deviceName") ?? "iPhone" }
        set { if !newValue.isEmpty { defaults.set(newValue, forKey: "deviceName") } }
    }

    static var lastUploadOK: Date? {
        get { defaults.object(forKey: "lastUploadOK") as? Date }
        set { defaults.set(newValue, forKey: "lastUploadOK") }
    }

    static var lastError: String {
        get { defaults.string(forKey: "lastError") ?? "" }
        set { defaults.set(newValue, forKey: "lastError") }
    }
}

enum TTLine {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSSXXX"
        return f
    }()

    static func timestamp(_ date: Date = Date()) -> String { formatter.string(from: date) }

    /// `tt|src=ios|kind=<kind>|dev=<device>|ts=<time>|k=v|...`, the format the
    /// relay already parses (server/ttserver/lines.py). Newlines in values
    /// would split the line, so they become spaces.
    static func make(kind: String, at date: Date = Date(), _ fields: [(String, String)] = []) -> String {
        var parts = ["tt", "src=ios", "kind=\(kind)", "dev=\(clean(TTSettings.deviceName))", "ts=\(timestamp(date))"]
        for (k, v) in fields { parts.append("\(k)=\(clean(v))") }
        return parts.joined(separator: "|")
    }

    private static func clean(_ s: String) -> String {
        s.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
    }
}

actor TTLog {
    static let shared = TTLog()

    private let queueURL: URL
    private var uploading = false

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        queueURL = dir.appendingPathComponent("tt-queue.txt")
    }

    /// Queued lines not yet confirmed by the relay.
    func pendingCount() -> Int {
        readQueue().count
    }

    /// Adds lines to the queue, then tries one upload. Never throws.
    func record(_ lines: [String]) async {
        let clean = lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if !clean.isEmpty { append(clean) }
        await flush()
    }

    /// Uploads everything queued, in batches. Stops quietly at the first failure.
    func flush() async {
        guard !uploading else { return }
        uploading = true
        defer { uploading = false }
        while true {
            let queue = readQueue()
            if queue.isEmpty { return }
            guard let url = ingestURL() else {
                TTSettings.lastError = "No relay URL set yet"
                return
            }
            let batch = Array(queue.prefix(500))
            var request = URLRequest(url: url, timeoutInterval: 15)
            request.httpMethod = "POST"
            request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = batch.joined(separator: "\n").data(using: .utf8)
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                    TTSettings.lastError = "\(TTLine.timestamp()): relay answered HTTP \(code)"
                    return
                }
                // Lines added while this batch was in flight are kept.
                drop(batch.count)
                TTSettings.lastUploadOK = Date()
                TTSettings.lastError = ""
            } catch {
                TTSettings.lastError = "\(TTLine.timestamp()): \(error.localizedDescription)"
                return
            }
        }
    }

    // MARK: - queue file

    private func ingestURL() -> URL? {
        let base = TTSettings.relayURL
        guard !base.isEmpty, var parts = URLComponents(string: base) else { return nil }
        var items = parts.queryItems ?? []
        items.removeAll { $0.name == "dev" }
        items.append(URLQueryItem(name: "dev", value: TTSettings.deviceName))
        parts.queryItems = items
        return parts.url
    }

    private func readQueue() -> [String] {
        guard let data = try? Data(contentsOf: queueURL), let text = String(data: data, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    private func writeQueue(_ lines: [String]) {
        // Keep at most ~50k lines (a few weeks offline) so the file can't grow forever.
        let kept = lines.suffix(50_000)
        let text = kept.isEmpty ? "" : kept.joined(separator: "\n") + "\n"
        try? Data(text.utf8).write(to: queueURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func append(_ lines: [String]) {
        writeQueue(readQueue() + lines)
    }

    private func drop(_ count: Int) {
        writeQueue(Array(readQueue().dropFirst(count)))
    }
}
