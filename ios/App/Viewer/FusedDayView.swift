// The "Day" tab: everything recorded about one day on one timeline. Screen
// time per device, what was going on in Claude (the relay's labels), places,
// motion, WHOOP sleep and workouts, and when TT Watch was running. Below the
// lanes, the same day as lists.

import Charts
import SwiftUI

struct FusedDayView: View {
    @State private var day = TTArchive.dayKey(Date())
    @State private var data = FusedDay.empty
    @State private var loading = false
    @State private var picked: FusedDay.Bar?

    var body: some View {
        NavigationStack {
            List {
                Section { DayPicker(day: $day) }
                StorySection(day: day, stories: $data.stories)
                if !data.errors.isEmpty {
                    Section {
                        ForEach(data.errors, id: \.self) { Text($0).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                Section {
                    LanesChart(data: data, picked: $picked)
                    if let b = picked { PickedBar(bar: b) }
                } header: {
                    Text("Timeline")
                } footer: {
                    Text("Tap a bar for what it was.")
                }
                totals
                if !data.claude.isEmpty {
                    Section("In Claude") {
                        ForEach(data.claude) { ClaudeBlockRow(block: $0) }
                    }
                }
                if !data.whoop.isEmpty {
                    Section("WHOOP") { WhoopDayRow(day: day, records: data.whoop) }
                }
                if !data.visits.isEmpty {
                    Section("Places") {
                        ForEach(data.visits) { v in
                            HStack {
                                Text("\(TTTime.clock(v.start))–\(v.open ? "now" : TTTime.clock(v.end))")
                                    .font(.caption.monospacedDigit())
                                Spacer()
                                Text(TTTime.duration(v.end.timeIntervalSince(v.start)))
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                if let url = v.mapsURL { Link(destination: url) { Image(systemName: "map") } }
                            }
                        }
                    }
                }
                if !data.watchRuns.isEmpty {
                    Section("TT Watch") {
                        ForEach(data.watchRuns) { r in
                            HStack {
                                Text("\(TTTime.clock(r.start))–\(TTTime.clock(r.end))").font(.caption.monospacedDigit())
                                Spacer()
                                Text(r.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle(DayTitle.title(day))
            .overlay { if loading && data.isEmpty { ProgressView() } }
            .refreshable { await load() }
            .task(id: day) { await load() }
        }
    }

    @ViewBuilder private var totals: some View {
        let t = data.totals
        if !t.isEmpty {
            Section("Totals") {
                ForEach(t, id: \.0) { name, seconds in
                    LabeledContent(name, value: TTTime.duration(seconds))
                }
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        picked = nil
        data = await FusedDay.load(day)
    }
}

// MARK: - the data

struct FusedDay {
    struct Bar: Identifiable {
        let lane: String
        let start: Date
        let end: Date
        let color: Color
        let title: String
        let detail: String
        let id = UUID()
    }

    struct Visit: Identifiable {
        let start: Date
        let end: Date
        let open: Bool
        let lat: String?
        let lon: String?
        var id: Date { start }
        var mapsURL: URL? {
            guard let lat, let lon else { return nil }
            return URL(string: "https://maps.apple.com/?ll=\(lat),\(lon)&q=Visit")
        }
    }

    struct Run: Identifiable {
        let run: String
        let start: Date
        let end: Date
        let ended: Bool
        let lines: Int
        var id: String { run + "\(start.timeIntervalSince1970)" }
        var detail: String { "\(lines) lines" + (ended ? ", ended" : "") }
    }

    var dayStart: Date
    var dayEnd: Date
    var bars: [Bar] = []
    var claude: [ClaudeBlock] = []
    var whoop: [[String: Any]] = []
    var visits: [Visit] = []
    var watchRuns: [Run] = []
    var stories: [DayStory] = []
    var totals: [(String, Double)] = []
    var errors: [String] = []

    static let empty = FusedDay(dayStart: Date(), dayEnd: Date())
    var isEmpty: Bool { bars.isEmpty && claude.isEmpty && whoop.isEmpty }

    /// The lanes, top to bottom; a lane only shows when it has something.
    static let laneOrder = ["Phone", "Laptop", "Other", "Claude", "Places", "Moving", "Sleep", "Workout", "TT Watch"]
    var lanes: [String] { Self.laneOrder.filter { l in bars.contains { $0.lane == l } } }

    static func load(_ day: String) async -> FusedDay {
        let (start, end) = DayLines.dayBounds(day)
        var out = FusedDay(dayStart: start, dayEnd: end)
        let stop = min(end, Date())
        let client: TTRelayClient
        do { client = try TTRelayClient.fromSettings() } catch {
            out.errors = [error.localizedDescription]
            return out
        }
        let range = ["start": TTTime.iso(start), "end": TTTime.iso(end), "tz": TimeZone.current.identifier]
        let daysBack = max(2, Int(Date().timeIntervalSince(start) / 86400) + 2)

        async let act = client.decode(TTActivity.self, "tt/activity", range.merging(["view": "devices", "min_seconds": "30"]) { $1 })
        async let blocks = client.decode(ClaudeBlocks.self, "tt/claude/blocks", range)
        async let whoopAll = client.json("tt/whoop", ["days": "\(daysBack)"])
        async let phone = DayLines.load(day, kinds: ["visit", "motion", "start", "beat", "change", "end"])
        async let story = client.decode(DayStories.self, "tt/story", ["day": day])

        do { out.stories = try await story.stories } catch { out.errors.append("Story: \(error.localizedDescription)") }

        // Screen time per device.
        do {
            var byLane: [String: Double] = [:]
            for s in try await act.segments {
                guard let a = s.startDate, let b = s.endDate else { continue }
                let lane = lane(of: s)
                byLane[lane, default: 0] += s.seconds
                out.bars.append(Bar(lane: lane, start: a, end: b, color: color(rating: s.rating),
                                    title: name(of: s), detail: [s.category, s.device].compactMap { $0 }.joined(separator: " · ")))
            }
            out.totals = byLane.sorted { $0.value > $1.value }.map { ("\($0.key) screen", $0.value) }
        } catch { out.errors.append("Screen time: \(error.localizedDescription)") }

        // Claude.
        do {
            out.claude = try await blocks.blocks
            for b in out.claude {
                guard let a = b.startDate, let e = b.endDate else { continue }
                out.bars.append(Bar(lane: "Claude", start: a, end: e, color: color(kind: b.kind),
                                    title: b.label ?? "Claude", detail: b.summary ?? b.kind ?? ""))
            }
            let secs = out.claude.reduce(0) { $0 + $1.seconds }
            if secs > 0 { out.totals.append(("In Claude", secs)) }
        } catch { out.errors.append("Claude: \(error.localizedDescription)") }

        // WHOOP: what overlaps the day.
        do {
            let all = try await whoopAll as? [[String: Any]] ?? []
            out.whoop = all.filter { r in
                let a = TTTime.parse(r["start"] as? String), e = TTTime.parse(r["end"] as? String)
                if let a, let e { return a < end && e > start }
                return WhoopView.when(r).map { $0 >= start && $0 < end } ?? false
            }
            for r in out.whoop {
                guard let a = TTTime.parse(r["start"] as? String), let e = TTTime.parse(r["end"] as? String) else { continue }
                switch r["kind"] as? String {
                case "sleep":
                    let nap = (r["nap"] as? Bool) == true
                    let perf = (r["score"] as? [String: Any])?["sleep_performance_percentage"] as? Double
                    out.bars.append(Bar(lane: "Sleep", start: a, end: e, color: .indigo, title: nap ? "Nap" : "Sleep",
                                        detail: perf.map { "performance \(Int($0))%" } ?? ""))
                case "workout":
                    out.bars.append(Bar(lane: "Workout", start: a, end: e, color: .orange,
                                        title: ((r["sport_name"] as? String) ?? "Workout").capitalized, detail: ""))
                default: break
                }
            }
        } catch { out.errors.append("WHOOP: \(error.localizedDescription)") }

        // Phone lines: places, motion, TT Watch.
        let lines = await phone
        if let e = lines.relayError { out.errors.append("Phone lines from this phone only (relay: \(e))") }
        for v in lines.of(["visit"]) {
            guard let a = TTTime.parse(v["arrive"]) else { continue }
            let open = v["depart"] == "-" || v["depart"] == nil
            let d = open ? stop : (TTTime.parse(v["depart"]) ?? stop)
            guard d > start, a < end else { continue }
            out.visits.append(Visit(start: max(a, start), end: min(d, end), open: open, lat: v["lat"], lon: v["lon"]))
        }
        // A visit can be logged twice (arrival, then departure): keep the most complete one per arrival.
        out.visits = Dictionary(grouping: out.visits, by: \.start).values
            .compactMap { $0.min { a, b in !a.open && b.open } }.sorted { $0.start < $1.start }
        for v in out.visits {
            out.bars.append(Bar(lane: "Places", start: v.start, end: v.end, color: .teal, title: "At a place",
                                detail: TTTime.duration(v.end.timeIntervalSince(v.start))))
        }

        let motion = lines.of(["motion"]).filter { $0.date != nil }
        var moving = 0.0
        for (i, m) in motion.enumerated() {
            let a = m.date!, e = i + 1 < motion.count ? motion[i + 1].date! : max(stop, a)
            let what = m["activity"] ?? "?"
            guard !["stationary", "unknown", "?"].contains(what) else { continue }
            moving += e.timeIntervalSince(a)
            out.bars.append(Bar(lane: "Moving", start: a, end: e, color: color(motion: what), title: what.capitalized,
                                detail: "\(m["conf"] ?? "?") confidence"))
        }
        if moving > 0 { out.totals.append(("Moving", moving)) }

        var runs: [String: (Date, Date, Bool, Int)] = [:]
        for l in lines.of(["start", "beat", "change", "end"]) {
            guard let t = l.date, let run = l["run"] else { continue }
            var r = runs[run] ?? (t, t, false, 0)
            r.0 = min(r.0, t); r.1 = max(r.1, t); r.3 += 1
            if l.kind == "end" { r.2 = true }
            runs[run] = r
        }
        out.watchRuns = runs.map { Run(run: $0.key, start: $0.value.0, end: $0.value.1, ended: $0.value.2, lines: $0.value.3) }
            .sorted { $0.start < $1.start }
        for r in out.watchRuns {
            out.bars.append(Bar(lane: "TT Watch", start: r.start, end: max(r.end, r.start.addingTimeInterval(60)),
                                color: .gray, title: "TT Watch running", detail: r.detail))
        }
        return out
    }

    private static func lane(of s: TTSegment) -> String {
        let text = "\(s.kind ?? "") \(s.device ?? "")".lowercased()
        if text.contains("phone") || text.contains("ios") { return "Phone" }
        if text.contains("desktop") || text.contains("laptop") || text.contains("window") || text.contains("mac") { return "Laptop" }
        return "Other"
    }

    private static func name(of s: TTSegment) -> String {
        if let d = s.domain, !d.isEmpty { return d }
        if let a = s.app, !a.isEmpty { return a }
        return s.title ?? "?"
    }

    static func color(rating: String?) -> Color {
        switch rating {
        case "productive": return .green
        case "distracting": return .red
        case "neutral": return .blue
        default: return .gray
        }
    }

    static func color(kind: String?) -> Color {
        switch kind {
        case "building", "writing", "learning", "research": return .green
        case "debugging", "planning", "admin": return .blue
        case "tinkering", "venting": return .red
        default: return .purple
        }
    }

    private static func color(motion: String) -> Color {
        switch motion {
        case "walking", "running", "cycling": return .mint
        case "automotive": return .brown
        default: return .secondary
        }
    }
}

// MARK: - Claude blocks (GET /tt/claude/blocks)

struct ClaudeBlocks: Decodable {
    let blocks: [ClaudeBlock]
}

struct ClaudeBlock: Decodable, Identifiable {
    struct Session: Decodable, Hashable {
        let title: String?
        let surface: String?
        let you: Int
        let claude: Int
    }
    struct Typed: Decodable, Hashable {
        let ts: String
        let session: String?
        let text: String
    }
    let start: String
    let end: String
    let seconds: Double
    let devices: [String: Double]?
    let sessions: [Session]
    let typed: [Typed]
    /// "project: goal", or an older free-form label.
    let label: String?
    let project: String?
    let goal: String?
    let summary: String?
    let kind: String?
    /// productive, mixed or unproductive.
    let verdict: String?
    var id: String { start }
    var startDate: Date? { TTTime.parse(start) }
    var endDate: Date? { TTTime.parse(end) }
}

struct ClaudeBlockRow: View {
    let block: ClaudeBlock
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(TTTime.clock(block.startDate))–\(TTTime.clock(block.endDate))").font(.caption.monospacedDigit())
                if let k = block.kind {
                    Text(k).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
                        .background(FusedDay.color(kind: k).opacity(0.2), in: Capsule())
                }
                if let v = block.verdict {
                    Text(v).font(.caption2)
                        .foregroundStyle(v == "productive" ? Color.green : v == "unproductive" ? Color.red : Color.secondary)
                }
                Spacer()
                Text(TTTime.duration(block.seconds)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if let p = block.project, let g = block.goal {
                (Text(p).bold() + Text(" · " + g)).font(.headline)
            } else {
                Text(block.label ?? (block.typed.isEmpty ? "Nothing typed" : "Not labeled yet")).font(.headline)
            }
            if let s = block.summary, !s.isEmpty { Text(s).font(.subheadline) }
            let titles = block.sessions.compactMap(\.title).filter { !$0.isEmpty }
            if !titles.isEmpty {
                Text(titles.prefix(4).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            if !block.typed.isEmpty {
                DisclosureGroup("What you typed (\(block.typed.count))", isExpanded: $open) {
                    ForEach(block.typed, id: \.self) { t in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(TTTime.clock(TTTime.parse(t.ts)))\(t.session.map { " · \($0)" } ?? "")")
                                .font(.caption2).foregroundStyle(.secondary)
                            Text(t.text).font(.caption).lineLimit(8)
                        }
                        .textSelection(.enabled)
                    }
                }
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - the lanes

private struct LanesChart: View {
    let data: FusedDay
    @Binding var picked: FusedDay.Bar?

    var body: some View {
        let lanes = data.lanes
        if lanes.isEmpty {
            Text("Nothing recorded for this day yet.").foregroundStyle(.secondary)
        } else {
            Chart(data.bars) { b in
                RectangleMark(xStart: .value("Start", max(b.start, data.dayStart)),
                              xEnd: .value("End", min(max(b.end, b.start.addingTimeInterval(90)), data.dayEnd)),
                              y: .value("Lane", b.lane), height: .ratio(0.7))
                    .foregroundStyle(b.color.opacity(picked == nil || picked?.id == b.id ? 0.9 : 0.35))
            }
            .chartXScale(domain: data.dayStart...data.dayEnd)
            .chartYScale(domain: lanes)
            .chartXAxis {
                AxisMarks(values: .stride(by: .hour, count: 3)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.hour())
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geo in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onTapGesture { p in
                            guard let frame = proxy.plotFrame else { return }
                            let origin = geo[frame].origin
                            let x = p.x - origin.x, y = p.y - origin.y
                            guard let t: Date = proxy.value(atX: x), let lane: String = proxy.value(atY: y) else { return }
                            let slack = (data.dayEnd.timeIntervalSince(data.dayStart)) / 150
                            picked = data.bars.filter { $0.lane == lane }
                                .min { distance($0, t) < distance($1, t) }
                                .flatMap { distance($0, t) <= slack ? $0 : nil }
                        }
                }
            }
            .frame(height: CGFloat(lanes.count) * 34 + 30)
        }
    }

    private func distance(_ b: FusedDay.Bar, _ t: Date) -> TimeInterval {
        if t >= b.start && t <= b.end { return 0 }
        return min(abs(t.timeIntervalSince(b.start)), abs(t.timeIntervalSince(b.end)))
    }
}

private struct PickedBar: View {
    let bar: FusedDay.Bar
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(bar.lane).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text("\(TTTime.clock(bar.start))–\(TTTime.clock(bar.end)) · \(TTTime.duration(bar.end.timeIntervalSince(bar.start)))")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(bar.title).font(.subheadline.weight(.semibold))
            if !bar.detail.isEmpty { Text(bar.detail).font(.caption) }
        }
    }
}

// MARK: - the story of the day

struct DayStories: Decodable {
    let day: String
    let stories: [DayStory]
}

struct DayStory: Decodable, Hashable {
    let slot: String
    let created: String
    let model: String?
    let text: String
}

/// The relay's story of the day (newest first): written 6 hours into the day and
/// once the day is verifiably over. "Write it now" asks for one on the spot.
private struct StorySection: View {
    let day: String
    @Binding var stories: [DayStory]
    @State private var shown = 0
    @State private var writing = false
    @State private var error: String?

    var body: some View {
        Section {
            if let s = stories.indices.contains(shown) ? stories[shown] : nil {
                StoryText(text: s.text)
                Text("Written \(TTTime.clock(TTTime.parse(s.created))) (\(s.slot))")
                    .font(.caption2).foregroundStyle(.secondary)
                if stories.count > 1 {
                    Picker("Version", selection: $shown) {
                        ForEach(stories.indices, id: \.self) { i in
                            Text("\(stories[i].slot) \(TTTime.clock(TTTime.parse(stories[i].created)))").tag(i)
                        }
                    }
                }
            } else {
                Text("No story yet. One is written 6 hours into the day, and the last once you've been off every screen for 2 hours after 6 PM.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Button(writing ? "Writing…" : "Write it now") { Task { await write() } }.disabled(writing)
        } header: {
            Text("The story of the day")
        }
        .onChange(of: day) { shown = 0 }
    }

    private func write() async {
        writing = true
        error = nil
        defer { writing = false }
        do {
            let client = try TTRelayClient.fromSettings()
            stories = try await client.decode(DayStories.self, "tt/story", ["day": day, "refresh": "1"], timeout: 120).stories
            shown = 0
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The little Markdown a story uses: ### headings, - bullets, **bold**.
private struct StoryText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, raw in
                let line = raw.trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("#") {
                    Text(inline(line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)))
                        .font(.headline).padding(.top, 4)
                } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•")
                        Text(inline(String(line.dropFirst(2))))
                    }
                    .font(.subheadline)
                } else if !line.isEmpty {
                    Text(inline(line)).font(.subheadline)
                }
            }
        }
        .textSelection(.enabled)
        .padding(.vertical, 2)
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}
