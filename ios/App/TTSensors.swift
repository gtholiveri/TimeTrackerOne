// Location and movement, recorded as tt| lines through TTLog.
//
// Location: visits (iOS's "arrived at / left a place") and significant
// location changes (a new fix about every 500 m of travel). Both keep working
// with the app closed: iOS relaunches it in the background for each event.
// That needs "Always" location permission.
//     tt|src=ios|kind=visit|...|arrive=<time>|depart=<time or ->|lat=..|lon=..|acc=..
//     tt|src=ios|kind=loc|...|lat=..|lon=..|acc=..|speed=..|course=..
//
// Movement: the motion coprocessor's activity log (stationary, walking,
// running, cycling, automotive). iOS keeps 7 days of it, so the app queries
// what's new since the last query whenever it runs (any Shortcuts action,
// any location event, opening the app). One line per change of activity:
//     tt|src=ios|kind=motion|...|activity=walking|conf=high
// ts is when the activity started, not when it was read.

import CoreLocation
import CoreMotion
import Foundation

@MainActor
final class TTSensors: NSObject, CLLocationManagerDelegate {
    static let shared = TTSensors()

    private let location = CLLocationManager()
    private let motion = CMMotionActivityManager()
    private var motionQueryRunning = false

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyHundredMeters
        location.pausesLocationUpdatesAutomatically = true
    }

    var locationStatus: String {
        switch location.authorizationStatus {
        case .authorizedAlways: return "Always"
        case .authorizedWhenInUse: return "While Using (needs Always)"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        case .notDetermined: return "Not asked yet"
        @unknown default: return "Unknown"
        }
    }

    var motionStatus: String {
        guard CMMotionActivityManager.isActivityAvailable() else { return "Not available" }
        switch CMMotionActivityManager.authorizationStatus() {
        case .authorized: return "Allowed"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        case .notDetermined: return "Not asked yet"
        @unknown default: return "Unknown"
        }
    }

    /// Called at every launch, including background relaunches for location
    /// events: monitoring has to be restarted each time the app starts.
    func start() {
        switch location.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            location.startMonitoringVisits()
            location.startMonitoringSignificantLocationChanges()
        default:
            break
        }
        catchUpMotion()
    }

    /// Asks for location (While Using first, then Always, as iOS requires)
    /// and motion permission. Only does anything while the app is open.
    func requestPermissions() {
        switch location.authorizationStatus {
        case .notDetermined: location.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: location.requestAlwaysAuthorization()
        default: break
        }
        catchUpMotion()  // the first motion query shows the Motion & Fitness prompt
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if manager.authorizationStatus == .authorizedWhenInUse {
                manager.requestAlwaysAuthorization()
            }
            self.start()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let arrive = visit.arrivalDate == .distantPast ? "-" : TTLine.timestamp(visit.arrivalDate)
        let depart = visit.departureDate == .distantFuture ? "-" : TTLine.timestamp(visit.departureDate)
        let at = visit.departureDate == .distantFuture ? visit.arrivalDate : visit.departureDate
        let line = TTLine.make(kind: "visit", at: at == .distantPast ? Date() : at, [
            ("arrive", arrive), ("depart", depart),
            ("lat", String(format: "%.5f", visit.coordinate.latitude)),
            ("lon", String(format: "%.5f", visit.coordinate.longitude)),
            ("acc", String(format: "%.0f", visit.horizontalAccuracy)),
        ])
        Task {
            await TTLog.shared.record([line])
            await MainActor.run { self.catchUpMotion() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let lines = locations.map { loc in
            TTLine.make(kind: "loc", at: loc.timestamp, [
                ("lat", String(format: "%.5f", loc.coordinate.latitude)),
                ("lon", String(format: "%.5f", loc.coordinate.longitude)),
                ("acc", String(format: "%.0f", loc.horizontalAccuracy)),
                ("speed", String(format: "%.1f", loc.speed)),
                ("course", String(format: "%.0f", loc.course)),
            ])
        }
        Task {
            await TTLog.shared.record(lines)
            await MainActor.run { self.catchUpMotion() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Nothing to do: iOS keeps trying, and the next event arrives on its own.
    }

    // MARK: - motion

    private static let lastMotionKey = "lastMotionQuery"
    private static let lastActivityKey = "lastMotionActivity"

    /// Records every activity change since the last query (at most 7 days back).
    func catchUpMotion() {
        guard CMMotionActivityManager.isActivityAvailable(), !motionQueryRunning else { return }
        let status = CMMotionActivityManager.authorizationStatus()
        guard status == .authorized || status == .notDetermined else { return }
        let defaults = UserDefaults.standard
        let now = Date()
        let weekAgo = now.addingTimeInterval(-7 * 24 * 3600 + 60)
        var from = (defaults.object(forKey: Self.lastMotionKey) as? Date) ?? now.addingTimeInterval(-3600)
        if from < weekAgo { from = weekAgo }
        motionQueryRunning = true
        motion.queryActivityStarting(from: from, to: now, to: .main) { [weak self] activities, _ in
            guard let self else { return }
            self.motionQueryRunning = false
            guard let activities else { return }
            var last = defaults.string(forKey: Self.lastActivityKey) ?? ""
            var lines: [String] = []
            for a in activities {
                let name = Self.name(of: a)
                // "unknown" in between real activities is noise; skip it.
                if name == last || name == "unknown" { continue }
                lines.append(TTLine.make(kind: "motion", at: a.startDate, [
                    ("activity", name), ("conf", Self.confidence(a.confidence)),
                ]))
                last = name
            }
            defaults.set(now, forKey: Self.lastMotionKey)
            defaults.set(last, forKey: Self.lastActivityKey)
            if !lines.isEmpty {
                Task { await TTLog.shared.record(lines) }
            }
        }
    }

    private static func name(of a: CMMotionActivity) -> String {
        if a.automotive { return "automotive" }
        if a.cycling { return "cycling" }
        if a.running { return "running" }
        if a.walking { return "walking" }
        if a.stationary { return "stationary" }
        return "unknown"
    }

    private static func confidence(_ c: CMMotionActivityConfidence) -> String {
        switch c {
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        @unknown default: return "unknown"
        }
    }
}
