// WHOOP as the relay pulled it: recovery, sleep, strain and workouts per day.

import Charts
import SwiftUI

struct WhoopView: View {
    @State private var records: [[String: Any]] = []
    @State private var status: [String: Any] = [:]
    @State private var error: String?
    @State private var days = 14
    @State private var loading = false

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.secondary) }
                }
                if !status.isEmpty {
                    Section("Sync") {
                        LabeledContent("Connected", value: (status["connected"] as? Bool) == true ? "Yes" : "No")
                        if let t = status["last_sync"] as? Double {
                            LabeledContent("Last sync", value: TTTime.ago(Date(timeIntervalSince1970: t)))
                        }
                        if let e = status["error"] as? String { Text(e).font(.caption).foregroundStyle(.red) }
                    }
                }
                let recs = rows(kind: "recovery")
                if !recs.isEmpty {
                    Section("Recovery") {
                        Chart(recs, id: \.date) { r in
                            BarMark(x: .value("Day", r.date, unit: .day), y: .value("Recovery", r.value))
                                .foregroundStyle(r.value >= 67 ? .green : r.value >= 34 ? .yellow : .red)
                        }
                        .chartYScale(domain: 0...100)
                        .frame(height: 140)
                    }
                }
                Section("Days") {
                    ForEach(dayKeys, id: \.self) { day in WhoopDayRow(day: day, records: records(on: day)) }
                }
                Section {
                    Picker("Days", selection: $days) { Text("7").tag(7); Text("14").tag(14); Text("30").tag(30); Text("90").tag(90) }
                }
            }
            .navigationTitle("WHOOP")
            .overlay { if loading && records.isEmpty { ProgressView() } }
            .refreshable { await load() }
            .task(id: days) { await load() }
        }
    }

    private struct Point { let date: Date; let value: Double }

    private func rows(kind: String) -> [Point] {
        records.filter { $0["kind"] as? String == kind }.compactMap { r in
            guard let d = Self.when(r), let s = (r["score"] as? [String: Any])?["recovery_score"] as? Double else { return nil }
            return Point(date: d, value: s)
        }
    }

    /// When a record happened: its end (sleeps and cycles end on the morning they count for), else start or creation.
    nonisolated static func when(_ r: [String: Any]) -> Date? {
        TTTime.parse(r["end"] as? String) ?? TTTime.parse(r["start"] as? String) ?? TTTime.parse(r["created_at"] as? String)
    }

    private func records(on day: String) -> [[String: Any]] {
        records.filter { r in Self.when(r).map(TTArchive.dayKey) == day }
    }

    private var dayKeys: [String] {
        Set(records.compactMap { Self.when($0).map(TTArchive.dayKey) }).sorted(by: >)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let client = try TTRelayClient.fromSettings()
            status = (try? await client.json("tt/whoop/status")) as? [String: Any] ?? [:]
            records = (try await client.json("tt/whoop", ["days": "\(days)"])) as? [[String: Any]] ?? []
            error = records.isEmpty ? "No WHOOP records yet." : nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct WhoopDayRow: View {
    let day: String
    let records: [[String: Any]]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(DayTitle.title(day)).font(.headline)
            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                Text(l).font(.subheadline)
            }
        }
    }

    private func score(_ r: [String: Any]) -> [String: Any] { r["score"] as? [String: Any] ?? [:] }
    private func num(_ v: Any?) -> Double? { (v as? Double) ?? (v as? Int).map(Double.init) }

    private var lines: [String] {
        var out: [String] = []
        for r in records {
            let s = score(r)
            switch r["kind"] as? String {
            case "recovery":
                var parts: [String] = []
                if let v = num(s["recovery_score"]) { parts.append("Recovery \(Int(v))%") }
                if let v = num(s["hrv_rmssd_milli"]) { parts.append("HRV \(Int(v)) ms") }
                if let v = num(s["resting_heart_rate"]) { parts.append("RHR \(Int(v))") }
                if let v = num(s["spo2_percentage"]) { parts.append("SpO2 \(String(format: "%.0f", v))%") }
                if !parts.isEmpty { out.append(parts.joined(separator: " · ")) }
            case "sleep":
                let stages = s["stage_summary"] as? [String: Any] ?? [:]
                let inBed = num(stages["total_in_bed_time_milli"]) ?? 0, awake = num(stages["total_awake_time_milli"]) ?? 0
                var parts = [((r["nap"] as? Bool) == true ? "Nap " : "Sleep ") + TTTime.duration((inBed - awake) / 1000)]
                if let v = num(s["sleep_performance_percentage"]) { parts.append("performance \(Int(v))%") }
                if let v = num(stages["total_rem_sleep_time_milli"]) { parts.append("REM \(TTTime.duration(v / 1000))") }
                if let v = num(stages["total_slow_wave_sleep_time_milli"]) { parts.append("deep \(TTTime.duration(v / 1000))") }
                out.append(parts.joined(separator: " · "))
            case "cycle":
                if let v = num(s["strain"]) {
                    out.append("Strain \(String(format: "%.1f", v))" + (num(s["average_heart_rate"]).map { " · avg HR \(Int($0))" } ?? ""))
                }
            case "workout":
                let name = (r["sport_name"] as? String) ?? "Workout"
                out.append("\(name.capitalized)" + (num(s["strain"]).map { " · strain \(String(format: "%.1f", $0))" } ?? ""))
            default:
                break
            }
        }
        return out
    }
}
