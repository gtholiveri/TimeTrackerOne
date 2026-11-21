// Shortcuts actions. They replace the shortcuts' own uploads: each one records its lines in the
// app's queue (TTLog) and tries an upload, and none of them ever fails, so an
// automation never shows an error banner, online or off.
//
// The Cherri shortcuts call them with rawAction (shortcuts/tt-actions.cherri),
// so parameter names here are part of that contract: keep them in step.

import AppIntents
import Foundation

/// Optional settings every action accepts, so the shortcuts can hand the app
/// the relay URL (from their import question) and the real device name.
private func applySettings(relay: String?, device: String?) {
    if let relay, !relay.isEmpty, !relay.contains("YOUR-") { TTSettings.relayURL = relay }
    if let device, !device.isEmpty { TTSettings.deviceName = device }
}

struct LogAppEventIntent: AppIntent {
    static let title: LocalizedStringResource = "Log App Event"
    static let description = IntentDescription(
        "Records an app opening or closing for TimeTracker and uploads it when there's network. Never fails."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Kind", description: "open or close", default: "open")
    var kind: String

    @Parameter(title: "App", description: "The app the automation passed in (Shortcut Input)")
    var app: String?

    @Parameter(title: "Current App", description: "Get Current App, if you have it")
    var current: String?

    @Parameter(title: "Device Name")
    var device: String?

    @Parameter(title: "Relay URL")
    var relay: String?

    func perform() async throws -> some IntentResult {
        applySettings(relay: relay, device: device)
        let line = TTLine.make(kind: kind == "close" ? "close" : "open", [
            ("input", app ?? ""), ("cur", current ?? ""),
        ])
        await TTLog.shared.record([line])
        await MainActor.run { TTSensors.shared.catchUpMotion() }
        return .result()
    }
}

/// The actions an "App is opened" / "App is closed" automation runs directly,
/// after Get Current App: no shortcut to import. iOS gives the automation no
/// app name of its own, so Get Current App is what says which app it was.
private func logAppEvent(_ kind: String, current: String?) async {
    let line = TTLine.make(kind: kind, [("input", ""), ("cur", current ?? "")])
    await TTLog.shared.record([line])
    await MainActor.run { TTSensors.shared.catchUpMotion() }
}

struct LogAppOpenedIntent: AppIntent {
    static let title: LocalizedStringResource = "Log App Opened"
    static let description = IntentDescription(
        "For the \"App is opened\" automation: put Get Current App first and pass its result in. Records it for TimeTracker. Never fails."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Current App", description: "The result of Get Current App")
    var current: String?

    static var parameterSummary: some ParameterSummary { Summary("Log \(\.$current) opened") }

    func perform() async throws -> some IntentResult {
        await logAppEvent("open", current: current)
        return .result()
    }
}

struct LogAppClosedIntent: AppIntent {
    static let title: LocalizedStringResource = "Log App Closed"
    static let description = IntentDescription(
        "For the \"App is closed\" automation: put Get Current App first and pass its result in. Records it for TimeTracker. Never fails."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Current App", description: "The result of Get Current App")
    var current: String?

    static var parameterSummary: some ParameterSummary { Summary("Log closed, now in \(\.$current)") }

    func perform() async throws -> some IntentResult {
        await logAppEvent("close", current: current)
        return .result()
    }
}

struct LogLinesIntent: AppIntent {
    static let title: LocalizedStringResource = "Log TT Lines"
    static let description = IntentDescription(
        "Records ready-made tt| lines (one per line, as TT Watch writes them) and uploads them when there's network. Never fails."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Lines")
    var lines: String?

    @Parameter(title: "Device Name")
    var device: String?

    @Parameter(title: "Relay URL")
    var relay: String?

    func perform() async throws -> some IntentResult {
        applySettings(relay: relay, device: device)
        let split = (lines ?? "").split(whereSeparator: \.isNewline).map(String.init)
        await TTLog.shared.record(split)
        await MainActor.run { TTSensors.shared.catchUpMotion() }
        return .result()
    }
}

struct SyncNowIntent: AppIntent {
    static let title: LocalizedStringResource = "Sync TimeTracker"
    static let description = IntentDescription("Uploads anything TimeTracker still has queued. Never fails.")
    static let openAppWhenRun = false

    @Parameter(title: "Device Name")
    var device: String?

    @Parameter(title: "Relay URL")
    var relay: String?

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        applySettings(relay: relay, device: device)
        await MainActor.run { TTSensors.shared.catchUpMotion() }
        await TTLog.shared.flush()
        let left = await TTLog.shared.pendingCount()
        return .result(value: left == 0 ? "all sent" : "\(left) lines still queued")
    }
}
