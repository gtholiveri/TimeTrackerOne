// The phone-side log, local first. Every line the app records (app opens and
// closes passed in by Shortcuts, TT Watch's lines, location, motion) is written
// to two files on the phone before anything else: the day's archive (kept,
// for the viewer) and the upload queue. That is all a Shortcuts action waits
// for: a file append, a few milliseconds. No action ever waits on the network.
//
// Uploading is the app's own job, separate from recording. The queue's oldest
// lines (up to 2,000) move into an outbox file, and a background URLSession
// uploads it to the relay's /tt/ingest. iOS runs that upload itself: it waits
// for a connection, carries on while the app is suspended, and wakes the app
// when it's done. Once the relay says 2xx the outbox file is deleted and the
// next batch goes. A failed upload never surfaces anywhere: the batch stays in
// the outbox and goes again at the next chance (any new line, the app coming
// to the front, iOS relaunching the app). The relay drops duplicates, so
// sending a batch twice is harmless.
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

    static let batchSize = 2000
    /// At most this many lines wait (about a month of heavy use); the oldest go first.
    static let maxQueued = 200_000

    private let dir: URL
    private let queueURL: URL
    private let outboxDir: URL

    init() {
        dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        queueURL = dir.appendingPathComponent("tt-queue.txt")
        outboxDir = dir.appendingPathComponent("tt-outbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: outboxDir, withIntermediateDirectories: true)
    }

    /// Lines on the phone not yet confirmed by the relay (queue plus outbox).
    func pendingCount() -> Int {
        readLines(queueURL).count + outboxFiles().reduce(0) { $0 + readLines($1).count }
    }

    /// Writes lines to the phone (archive and upload queue) and returns. The
    /// upload is started in the background and never waited for. Never throws.
    /// (uploadNow is kept for callers; uploads are background now either way.)
    func record(_ lines: [String], uploadNow: Bool = true) {
        let clean = lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !clean.isEmpty else { return }
        TTArchive.append(clean)
        appendToQueue(clean)
        Task.detached(priority: .utility) { await TTLog.shared.sync() }
    }

    /// Starts uploading whatever is waiting, in the background. Returns at once.
    func flush() {
        Task.detached(priority: .utility) { await TTLog.shared.sync() }
    }

    /// Hands the outbox to the background upload session: every outbox file not
    /// already uploading, or, when the outbox is empty, the queue's next batch.
    func sync() async {
        guard let url = ingestURL() else {
            TTSettings.lastError = "No relay URL set yet"
            return
        }
        let uploading = await TTUploader.shared.filesInFlight()
        var files = outboxFiles()
        if files.isEmpty, let batch = takeBatch() { files = [batch] }
        for f in files where !uploading.contains(f.lastPathComponent) {
            TTUploader.shared.upload(file: f, to: url)
        }
    }

    /// The upload session reports back.
    func finished(file name: String, status: Int, error: String?) {
        let file = outboxDir.appendingPathComponent(name)
        if (200..<300).contains(status) {
            try? FileManager.default.removeItem(at: file)
            TTSettings.lastUploadOK = Date()
            TTSettings.lastError = ""
            // More waiting? Send the next batch.
            if !readLines(queueURL).isEmpty || !outboxFiles().isEmpty {
                Task.detached(priority: .utility) { await TTLog.shared.sync() }
            }
        } else {
            // Kept in the outbox; it goes again with the next sync.
            TTSettings.lastError = "\(TTLine.timestamp()): " + (error ?? "relay answered HTTP \(status)")
        }
    }

    // MARK: - files

    private func ingestURL() -> URL? {
        let base = TTSettings.relayURL
        guard !base.isEmpty, var parts = URLComponents(string: base) else { return nil }
        var items = parts.queryItems ?? []
        items.removeAll { $0.name == "dev" }
        items.append(URLQueryItem(name: "dev", value: TTSettings.deviceName))
        parts.queryItems = items
        return parts.url
    }

    private static let protection: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]

    private func readLines(_ url: URL) -> [String] {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    /// Appends without rewriting the file, so a long offline stretch stays cheap.
    private func appendToQueue(_ lines: [String]) {
        let data = Data((lines.joined(separator: "\n") + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: queueURL) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: queueURL, options: Self.protection)
        }
    }

    /// Moves the queue's oldest lines into a new outbox file. The outbox file is
    /// written before the lines leave the queue, so nothing is lost if the app
    /// stops in between (at worst a batch is sent twice).
    private func takeBatch() -> URL? {
        var queue = readLines(queueURL)
        if queue.isEmpty { return nil }
        if queue.count > Self.maxQueued { queue = Array(queue.suffix(Self.maxQueued)) }
        let batch = queue.prefix(Self.batchSize)
        let name = String(format: "%.0f", Date().timeIntervalSince1970 * 1000) + "-\(UUID().uuidString.prefix(8)).txt"
        let file = outboxDir.appendingPathComponent(name)
        do {
            try Data((batch.joined(separator: "\n") + "\n").utf8).write(to: file, options: Self.protection)
        } catch {
            return nil
        }
        let rest = queue.dropFirst(batch.count)
        try? Data((rest.isEmpty ? "" : rest.joined(separator: "\n") + "\n").utf8).write(to: queueURL, options: Self.protection)
        return file
    }

    private func outboxFiles() -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: outboxDir.path)) ?? []
        return names.filter { $0.hasSuffix(".txt") }.sorted().map { outboxDir.appendingPathComponent($0) }
    }
}

/// The background upload session. iOS performs the uploads, also while the app
/// is suspended or not running, and waits for a network by itself.
final class TTUploader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = TTUploader()
    static let identifier = "com.gtholiveri.timetracker.upload"

    /// Set by the app delegate when iOS wakes the app for finished uploads.
    var backgroundCompletion: (() -> Void)?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.allowsConstrainedNetworkAccess = true
        config.timeoutIntervalForResource = 7 * 24 * 3600
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    /// Makes sure the session exists (so iOS can deliver events for it after a relaunch).
    func activate() { _ = session }

    func filesInFlight() async -> Set<String> {
        let tasks = await session.allTasks
        return Set(tasks.filter { $0.state == .running || $0.state == .suspended }.compactMap(\.taskDescription))
    }

    func upload(file: URL, to url: URL) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = file.lastPathComponent
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let name = task.taskDescription else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let message = error?.localizedDescription
        Task { await TTLog.shared.finished(file: name, status: error == nil ? status : 0, error: message) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }
}
