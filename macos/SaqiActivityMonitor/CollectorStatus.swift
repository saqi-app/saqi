import Foundation

func monitorPythonExecutable(_ configured: String?) -> String {
    guard let configured, configured.hasPrefix("/") else { return "/usr/bin/python3" }
    return configured
}

enum LaunchctlPresence: Equatable {
    case loaded, unloaded, unknown

    static func inspect(exitCode: Int32, diagnostics: String, label: String) -> LaunchctlPresence {
        if exitCode == 0 { return .loaded }
        guard exitCode > 0 else { return .unknown }
        // Match the exact-label diagnostic used by rig_launchctl.py. Other
        // failures cannot establish that a local translation job has stopped.
        let lines = diagnostics.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != "Bad request." }
        let prefix = "Could not find service \"\(label)\" in domain for "
        guard lines.count == 1, let line = lines.first,
              line.hasPrefix(prefix), line.count > prefix.count else { return .unknown }
        return .unloaded
    }

    var canStart: Bool { self == .unloaded }
    var canStop: Bool { self != .unloaded }
}

struct CollectorStatus: Decodable {
    struct Counts: Decodable {
        let authorName: String
        let sourceUrl: String?
        let processed: Int?
        let total: Int?
        let added: Int
        let updated: Int
        let unchanged: Int
        let reviewRequired: Int
        var summary: String { "\(added) added · \(updated) updated · \(unchanged) unchanged · \(reviewRequired) need review" }
    }
    struct Failure: Decodable { let code: String; let message: String }
    struct Review: Decodable { let authorName: String; let total: Int }
    let version: Int
    let state: String
    let seenAt: String?
    let progressAt: String?
    let retryAt: String?
    let current: Counts?
    let lastCompleted: Counts?
    let reviewWarning: Review?
    let error: Failure?
    static let states: Set<String> = ["idle", "collecting", "paused", "human_required", "cooldown", "error"]
    static func decode(_ data: Data) -> CollectorStatus? {
        guard data.count <= 65536, let value = try? JSONDecoder().decode(Self.self, from: data),
              value.version == 1, states.contains(value.state) else { return nil }
        return value
    }
    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    func connected(at now: Date = Date()) -> Bool {
        guard let date = Self.date(seenAt) else { return false }
        return now.timeIntervalSince(date) >= 0 && now.timeIntervalSince(date) < 150
    }
    var label: String {
        guard connected() else { return "Chrome disconnected" }
        switch state {
        case "collecting": return "Collecting"
        case "paused": return "Paused"
        case "human_required": return "Verify in Chrome"
        case "cooldown": return error?.code == "SOURCE_COOLDOWN" ? "Waiting for source" : "Waiting to retry"
        case "error": return "Needs attention"
        default: return reviewWarning == nil ? "Scheduled" : "Needs review"
        }
    }
    var detail: String {
        var lines: [String] = []
        if let current {
            lines.append("\(current.authorName): \(current.processed ?? 0) / \(current.total ?? 0) poems checked")
            lines.append(current.summary)
        } else if let lastCompleted {
            lines.append("Last author: \(lastCompleted.authorName)")
            lines.append(lastCompleted.summary)
        }
        if let error { lines.append(error.message) }
        if let date = Self.date(retryAt) { lines.append("Retry at \(date.formatted(date: .abbreviated, time: .standard))") }
        if connected() && state == "human_required" {
            lines.append("Open the Saqi Chrome popup, choose Open collector tab, finish source verification, then choose Retry.")
        }
        if let reviewWarning { lines.append("Latest review warning: \(reviewWarning.authorName), \(reviewWarning.total) poems. Open the Chrome popup.") }
        if !connected() { lines.append("Open personal Chrome with the Saqi extension enabled. Last known state: \(state).") }
        if lines.isEmpty { lines.append("Collection is controlled by the Saqi Chrome popup.") }
        return lines.joined(separator: "\n")
    }
}
