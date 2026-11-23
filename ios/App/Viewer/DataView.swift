// The "Data" tab: has data been arriving, per day, from every source, plus
// TT Watch's state and every run of it. Tap a day for its totals.

import Charts
import SwiftUI

struct DataView: View {
    @State private var coverage: TTCoverage?
    @State private var summary: TTSummary?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            List {
                Section("TT Watch") { WatchStatusRows() }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").font(.footnote) }
                }
                Section {
                    ForEach(dayKeys, id: \.self) { day in
                        NavigationLink(value: day) { DayRow(day: day, cov: covDay(day), sum: sumDay(day)) }
                    }
                } header: {
                    Text("Days")
                } footer: {
                    Text("Phone lines are what the relay has (or, offline, what this phone recorded). Screen time is all devices fused, from ActivityWatch.")
                }
                if let runs = coverage?.watch_runs, !runs.isEmpty {
                    Section("TT Watch runs") {
                        ForEach(runs.reversed()) { r in WatchRunRow(run: r) }
                    }
                }
                if let last = coverage?.last_received, !last.isEmpty {
                    Section("Relay last heard from") {
                        ForEach(last.keys.sorted(), id: \.self) { k in
                            LabeledContent(k == "ios" ? "Phone" : k.capitalized,
                                           value: TTTime.ago(TTTime.parse(last[k])))
                        }
                    }
                }
            }
            .navigationTitle("Data")
            .navigationDestination(for: String.self) { DayDetailView(day: $0, sum: sumDay($0), cov: covDay($0)) }
            .overlay { if loading && coverage == nil { ProgressView() } }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private var dayKeys: [String] {
        var keys = Set(coverage?.days.map(\.day) ?? [])
        keys.formUnion(summary?.days.map(\.day) ?? [])
        keys.formUnion(TTArchive.days().prefix(7))
        keys.insert(TTArchive.dayKey(Date()))
        return keys.sorted(by: >)
    }

    private func covDay(_ d: String) -> TTCoverage.Day? { coverage?.days.first { $0.day == d } }
    private func sumDay(_ d: String) -> TTSummary.Day? { summary?.days.first { $0.day == d } }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let client = try TTRelayClient.fromSettings()
            let tz = TimeZone.current.identifier
            async let cov = client.decode(TTCoverage.self, "tt/coverage", ["days": "8", "tz": tz])
            async let sum = client.decode(TTSummary.self, "tt/summary", ["days": "7", "tz": tz, "top": "10"])
            coverage = try await cov
            error = nil
            do { summary = try await sum } catch { self.error = "Screen time: \(error.localizedDescription)" }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct WatchStatusRows: View {
    @State private var tick = 0

    var body: some View {
        let alive = TTWatchGuard.looksAlive
        Group {
            LabeledContent("Status") {
                Label(alive ? "Running" : "Not heard from", systemImage: alive ? "checkmark.circle.fill" : "xmark.octagon.fill")
                    .foregroundStyle(alive ? .green : .red)
            }
            LabeledContent("Last line", value: TTTime.ago(TTWatchGuard.lastHeard))
            if !TTWatchGuard.lastRun.isEmpty {
                LabeledContent("Run", value: TTWatchGuard.lastRun + (TTWatchGuard.lastEnded ? " (ended)" : ""))
            }
            Link(destination: TTWatchGuard.restartURL) {
                Label("Start TT Watch now", systemImage: "play.circle")
            }
        }
        .id(tick)
        .onReceive(Timer.publish(every: 15, on: .main, in: .common).autoconnect()) { _ in tick += 1 }
    }
}

private struct DayRow: View {
    let day: String
    let cov: TTCoverage.Day?
    let sum: TTSummary.Day?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(DayTitle.title(day)).font(.headline)
                Spacer()
                if let sum { Text(TTTime.duration(sum.attention_seconds)).font(.headline.monospacedDigit()) }
            }
            HStack(spacing: 10) {
                if let cov {
                    Chip("phone", cov.ios_total)
                    Chip("watch", ["start", "change", "beat", "end"].reduce(0) { $0 + (cov.ios[$1] ?? 0) })
                    Chip("apps", (cov.ios["open"] ?? 0) + (cov.ios["close"] ?? 0))
                    Chip("gps", (cov.ios["loc"] ?? 0) + (cov.ios["visit"] ?? 0))
                    Chip("motion", cov.ios["motion"] ?? 0)
                    Chip("safari", cov.safari)
                } else {
                    let n = TTArchive.lines(day: day).count
                    Text(n > 0 ? "\(n) lines on this phone" : "Nothing from the relay").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            if let sum {
                Text("\(sum.phone_unlocks) unlocks · " + sum.by_top_category.prefix(3).map { "\($0.name) \(TTTime.duration($0.seconds))" }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct Chip: View {
    let label: String
    let n: Int
    init(_ label: String, _ n: Int) { self.label = label; self.n = n }
    var body: some View {
        VStack(spacing: 0) {
            Text("\(n)").monospacedDigit().foregroundStyle(n == 0 ? .red : .primary)
            Text(label).foregroundStyle(.secondary)
        }
    }
}

private struct WatchRunRow: View {
    let run: TTCoverage.Run
    var body: some View {
        let first = TTTime.parse(run.first), last = TTTime.parse(run.last)
        VStack(alignment: .leading, spacing: 2) {
            Text("\(first?.formatted(date: .abbreviated, time: .shortened) ?? run.first) to \(TTTime.clock(last))")
            Text("\(String(format: "%.1f", run.hours)) h · \(run.lines) lines · run \(run.run)\(run.ended ? " · reached its end" : "")")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

enum DayTitle {
    static func title(_ day: String) -> String {
        guard let d = TTArchive.date(ofDay: day) else { return day }
        if Calendar.current.isDateInToday(d) { return "Today" }
        if Calendar.current.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}

struct DayDetailView: View {
    let day: String
    let sum: TTSummary.Day?
    let cov: TTCoverage.Day?

    var body: some View {
        List {
            Section {
                NavigationLink("Timeline") { TimelineView(initialDay: day) }
                NavigationLink("Map") { MapDayView(initialDay: day) }
                NavigationLink("Motion") { MotionView(initialDay: day) }
                NavigationLink("Raw lines") { RawLinesView(initialDay: day) }
            }
            if let sum {
                Section("Screen time") {
                    LabeledContent("Total", value: TTTime.duration(sum.attention_seconds))
                    LabeledContent("Phone unlocks", value: "\(sum.phone_unlocks)")
                    LabeledContent("First / last active", value: "\(TTTime.clock(TTTime.parse(sum.first_active))) / \(TTTime.clock(TTTime.parse(sum.last_active)))")
                    LabeledContent("Longest productive stretch", value: TTTime.duration(sum.longest_productive_streak_seconds))
                    ForEach(sum.device_seconds.sorted { $0.value > $1.value }, id: \.key) { k, v in
                        LabeledContent(k, value: TTTime.duration(v))
                    }
                }
                if !sum.by_rating.isEmpty {
                    Section("By rating") {
                        Chart(sum.by_rating.sorted { $0.value > $1.value }, id: \.key) { k, v in
                            BarMark(x: .value("Minutes", v / 60), y: .value("Rating", k.isEmpty ? "unrated" : k))
                        }
                        .frame(height: CGFloat(max(1, sum.by_rating.count)) * 32)
                    }
                }
                NamedSection(title: "Categories", items: sum.by_category)
                NamedSection(title: "Apps", items: sum.top_apps)
                NamedSection(title: "Sites", items: sum.top_domains)
            }
            if let cov {
                Section("Phone lines received") {
                    ForEach(cov.ios.sorted { $0.key < $1.key }, id: \.key) { k, v in
                        LabeledContent(k, value: "\(v)")
                    }
                    LabeledContent("Safari records", value: "\(cov.safari)")
                    LabeledContent("Devices", value: cov.devices.joined(separator: ", "))
                }
            }
        }
        .navigationTitle(DayTitle.title(day))
    }
}

private struct NamedSection: View {
    let title: String
    let items: [TTNamed]
    var body: some View {
        if !items.isEmpty {
            Section(title) {
                let top = Array(items.prefix(12))
                Chart(top) { item in
                    BarMark(x: .value("Minutes", item.seconds / 60), y: .value(title, item.name.isEmpty ? "?" : item.name))
                }
                .chartXAxisLabel("minutes")
                .frame(height: CGFloat(top.count) * 28 + 30)
            }
        }
    }
}
