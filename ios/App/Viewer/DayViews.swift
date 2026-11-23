// Per-day views: the timeline, the GPS map, motion and the raw lines.

import Charts
import MapKit
import SwiftUI

/// A date picker for one day, as the archive's yyyy-MM-dd key.
struct DayPicker: View {
    @Binding var day: String
    var body: some View {
        let binding = Binding<Date>(
            get: { TTArchive.date(ofDay: day) ?? Date() },
            set: { day = TTArchive.dayKey($0) })
        HStack {
            Button { shift(-1) } label: { Image(systemName: "chevron.left") }
            DatePicker("Day", selection: binding, in: ...Date(), displayedComponents: .date).labelsHidden()
            Button { shift(1) } label: { Image(systemName: "chevron.right") }
                .disabled(day >= TTArchive.dayKey(Date()))
        }
        .buttonStyle(.borderless)
    }

    private func shift(_ n: Int) {
        let d = TTArchive.date(ofDay: day) ?? Date()
        day = TTArchive.dayKey(Calendar.current.date(byAdding: .day, value: n, to: d)!)
    }
}

private struct SourceFooter: View {
    let lines: DayLines?
    var body: some View {
        if let lines {
            VStack(alignment: .leading) {
                Text("From: \(lines.source.rawValue)")
                if let e = lines.relayError { Text("Relay: \(e)") }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: - timeline

struct TimelineView: View {
    enum Mode: String, CaseIterable { case screen = "Screen", devices = "Devices", phone = "Phone events" }
    @State var day: String
    @State private var mode = Mode.screen
    @State private var segments: [TTSegment] = []
    @State private var phone: DayLines?
    @State private var error: String?
    @State private var loading = false

    init(initialDay: String = TTArchive.dayKey(Date())) { _day = State(initialValue: initialDay) }

    var body: some View {
        List {
            Section {
                DayPicker(day: $day)
                Picker("View", selection: $mode) { ForEach(Mode.allCases, id: \.self) { Text($0.rawValue) } }
                    .pickerStyle(.segmented)
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.secondary) } }
            if mode == .phone {
                Section {
                    ForEach(phone?.of(["open", "close", "start", "change", "beat", "end", "visit", "motion", "locpause"]) ?? []) { l in
                        HStack(alignment: .firstTextBaseline) {
                            Text(TTTime.clock(l.date)).font(.caption.monospacedDigit()).frame(width: 64, alignment: .leading)
                            Text(l.summary).font(.subheadline)
                        }
                    }
                } footer: { SourceFooter(lines: phone) }
            } else {
                Section {
                    ForEach(segments) { s in SegmentRow(s: s, showDevice: mode == .devices) }
                } footer: {
                    Text("\(segments.count) segments of 30 s or more, fused by the relay")
                }
            }
        }
        .navigationTitle("Timeline")
        .overlay { if loading { ProgressView() } }
        .refreshable { await load() }
        .task(id: "\(day)|\(mode.rawValue)") { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        error = nil
        if mode == .phone {
            phone = await DayLines.load(day)
            return
        }
        do {
            // A bare date as end means "through that day" (the relay's tracking day starts at 4 AM).
            let q = ["start": day, "end": day, "tz": TimeZone.current.identifier,
                     "view": mode == .screen ? "attention" : "devices", "min_seconds": "30"]
            segments = try await TTRelayClient.fromSettings().decode(TTActivity.self, "tt/activity", q).segments
        } catch {
            segments = []
            self.error = error.localizedDescription
        }
    }
}

private struct SegmentRow: View {
    let s: TTSegment
    let showDevice: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(color(s.rating)).frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("\(TTTime.clock(s.startDate))–\(TTTime.clock(s.endDate))").font(.caption.monospacedDigit())
                    Spacer()
                    Text(TTTime.duration(s.seconds)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Text(name).font(.subheadline).lineLimit(1)
                Text([s.category, showDevice ? s.device : s.kind].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
    private var name: String {
        if let d = s.domain, !d.isEmpty { return "\(s.app ?? "") · \(d)" }
        if let t = s.title, !t.isEmpty, t != s.app { return "\(s.app ?? "") · \(t)" }
        return s.app ?? "?"
    }
    private func color(_ rating: String?) -> Color {
        switch rating {
        case "productive": return .green
        case "distracting": return .red
        case "neutral": return .gray
        default: return .secondary
        }
    }
}

// MARK: - map

struct MapDayView: View {
    @State var day: String
    @State private var lines: DayLines?
    @State private var maxAccuracy = 100.0
    @State private var loading = false

    init(initialDay: String = TTArchive.dayKey(Date())) { _day = State(initialValue: initialDay) }

    private var fixes: [PhoneLine] {
        (lines?.of(["loc"]) ?? []).filter { (Double($0["acc"] ?? "") ?? 9999) <= maxAccuracy && $0.coordinate != nil }
    }
    private var visits: [PhoneLine] { (lines?.of(["visit"]) ?? []).filter { $0.coordinate != nil } }

    /// The track split wherever iOS paused it or fixes are 15+ minutes apart.
    private var tracks: [[CLLocationCoordinate2D]] {
        var out: [[CLLocationCoordinate2D]] = []
        var cur: [CLLocationCoordinate2D] = []
        var lastDate: Date?
        for l in (lines?.lines ?? []) {
            if l.kind == "locpause" { if cur.count > 1 { out.append(cur) }; cur = []; continue }
            guard l.kind == "loc", (Double(l["acc"] ?? "") ?? 9999) <= maxAccuracy, let c = l.coordinate else { continue }
            if let ld = lastDate, let d = l.date, d.timeIntervalSince(ld) > 15 * 60 {
                if cur.count > 1 { out.append(cur) }
                cur = []
            }
            cur.append(c)
            lastDate = l.date
        }
        if cur.count > 1 { out.append(cur) }
        return out
    }

    private var distanceKm: Double {
        tracks.reduce(0) { sum, t in
            sum + zip(t, t.dropFirst()).reduce(0) {
                $0 + CLLocation(latitude: $1.0.latitude, longitude: $1.0.longitude)
                    .distance(from: CLLocation(latitude: $1.1.latitude, longitude: $1.1.longitude))
            }
        } / 1000
    }

    var body: some View {
        VStack(spacing: 0) {
            Map {
                ForEach(Array(tracks.enumerated()), id: \.offset) { _, t in
                    MapPolyline(coordinates: t).stroke(.blue, lineWidth: 4)
                }
                ForEach(visits) { v in
                    Annotation(TTTime.clock(TTTime.parse(v["arrive"])), coordinate: v.coordinate!) {
                        Circle().fill(.orange).stroke(.white, lineWidth: 2).frame(width: 14, height: 14)
                    }
                }
            }
            .frame(minHeight: 320)
            List {
                Section {
                    DayPicker(day: $day)
                    LabeledContent("GPS fixes", value: "\(fixes.count)")
                    LabeledContent("Distance", value: String(format: "%.1f km", distanceKm))
                    LabeledContent("Median accuracy", value: medianAccuracy)
                    Picker("Hide fixes worse than", selection: $maxAccuracy) {
                        Text("30 m").tag(30.0); Text("100 m").tag(100.0); Text("Show all").tag(100_000.0)
                    }
                } footer: { SourceFooter(lines: lines) }
                if !visits.isEmpty {
                    Section("Visits") {
                        ForEach(visits) { v in Text(v.summary).font(.subheadline) }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
        .navigationTitle("Map")
        .overlay { if loading { ProgressView() } }
        .task(id: day) {
            loading = true
            lines = await DayLines.load(day, kinds: ["loc", "visit", "locpause"])
            loading = false
        }
    }

    private var medianAccuracy: String {
        let a = fixes.compactMap { Double($0["acc"] ?? "") }.sorted()
        return a.isEmpty ? "-" : "±\(Int(a[a.count / 2])) m"
    }
}

// MARK: - motion

struct MotionView: View {
    @State var day: String
    @State private var lines: DayLines?

    init(initialDay: String = TTArchive.dayKey(Date())) { _day = State(initialValue: initialDay) }

    private struct Stretch: Identifiable {
        let activity: String
        let start: Date
        let end: Date
        let conf: String
        var id: Date { start }
        var seconds: Double { end.timeIntervalSince(start) }
    }

    private var stretches: [Stretch] {
        let m = (lines?.of(["motion"]) ?? []).filter { $0.date != nil }
        let (_, dayEnd) = DayLines.dayBounds(day)
        let stop = min(dayEnd, Date())
        return m.enumerated().map { i, l in
            Stretch(activity: l["activity"] ?? "?", start: l.date!,
                    end: i + 1 < m.count ? m[i + 1].date! : max(stop, l.date!), conf: l["conf"] ?? "")
        }
    }

    var body: some View {
        let s = stretches
        let totals = Dictionary(grouping: s, by: \.activity).mapValues { $0.reduce(0) { $0 + $1.seconds } }
        List {
            Section { DayPicker(day: $day) }
            if !totals.isEmpty {
                Section("Totals") {
                    Chart(totals.sorted { $0.value > $1.value }, id: \.key) { k, v in
                        BarMark(x: .value("Hours", v / 3600), y: .value("Activity", k.capitalized))
                    }
                    .chartXAxisLabel("hours")
                    .frame(height: CGFloat(totals.count) * 32 + 30)
                }
            }
            Section {
                ForEach(s.reversed()) { st in
                    HStack {
                        Text(TTTime.clock(st.start)).font(.caption.monospacedDigit()).frame(width: 64, alignment: .leading)
                        Text(st.activity.capitalized)
                        Spacer()
                        Text(TTTime.duration(st.seconds)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            } footer: { SourceFooter(lines: lines) }
        }
        .navigationTitle("Motion")
        .task(id: day) { lines = await DayLines.load(day, kinds: ["motion"]) }
    }
}

// MARK: - raw lines

struct RawLinesView: View {
    @State var day: String
    @State private var lines: DayLines?
    @State private var kind = "all"
    @State private var search = ""
    @State private var useRelay = true

    init(initialDay: String = TTArchive.dayKey(Date())) { _day = State(initialValue: initialDay) }

    private var kinds: [String] { ["all"] + Set((lines?.lines ?? []).map(\.kind)).sorted() }
    private var shown: [PhoneLine] {
        (lines?.lines ?? []).filter { (kind == "all" || $0.kind == kind) && (search.isEmpty || $0.raw.localizedCaseInsensitiveContains(search)) }
    }

    var body: some View {
        List {
            Section {
                DayPicker(day: $day)
                Picker("Kind", selection: $kind) { ForEach(kinds, id: \.self) { Text($0) } }
                Toggle("Include the relay's copy", isOn: $useRelay)
            } footer: {
                Text("\(shown.count) of \(lines?.lines.count ?? 0) lines. Long-press a line to copy it.")
            }
            Section {
                ForEach(shown) { l in
                    Text(l.raw).font(.caption2.monospaced()).textSelection(.enabled)
                        .contextMenu { Button("Copy") { UIPasteboard.general.string = l.raw } }
                }
            } footer: { SourceFooter(lines: lines) }
        }
        .searchable(text: $search)
        .navigationTitle("Raw lines")
        .task(id: "\(day)|\(useRelay)") { lines = await DayLines.load(day, useRelay: useRelay) }
    }
}
